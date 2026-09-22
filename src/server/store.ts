import { DatabaseSync } from 'node:sqlite';
import { mkdirSync, readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { contentId, sha256Hex } from '../shared/digest.js';
import type { Branch, Event, EventPayloadMap, EventType, Material, Project } from '../shared/types.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, case_pack_version TEXT NOT NULL, created_at TEXT NOT NULL,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL,
  head_event_id TEXT, forked_from_event_id TEXT, purpose TEXT NOT NULL,
  seq_counter INTEGER NOT NULL DEFAULT 0,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  seq INTEGER NOT NULL, parent_id TEXT, type TEXT NOT NULL,
  creator TEXT NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL,
  UNIQUE(branch_id, seq)
);
CREATE TABLE IF NOT EXISTS materials (
  id TEXT NOT NULL, project_id TEXT NOT NULL, kind TEXT NOT NULL,
  data TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS blobs (
  sha256 TEXT PRIMARY KEY, bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS computations (
  id TEXT NOT NULL, project_id TEXT NOT NULL, branch_id TEXT NOT NULL,
  seq_at INTEGER NOT NULL, node_json TEXT NOT NULL,
  PRIMARY KEY (project_id, branch_id, seq_at, id)
);
CREATE TABLE IF NOT EXISTS staging (
  operation_id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
  stage INTEGER NOT NULL, created_at TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

export interface StagingOp {
  operationId: string; projectId: string; kind: 'import' | 'delete' | 'export-commit';
  stage: number; createdAt: string; payload: Record<string, unknown>;
}

export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.db.exec(SCHEMA);
  }

  // ---------- 半写恢复：崩溃后调用，回滚未到 stage=done 的暂存操作 ----------
  recoverInterrupted(): StagingOp[] {
    const rows = this.db.prepare('SELECT * FROM staging').all() as Record<string, unknown>[];
    const interrupted: StagingOp[] = [];
    for (const r of rows) {
      const op: StagingOp = {
        operationId: r.operation_id as string, projectId: r.project_id as string,
        kind: r.kind as StagingOp['kind'], stage: r.stage as number,
        createdAt: r.created_at as string, payload: JSON.parse(r.payload as string),
      };
      if (op.stage < 3) interrupted.push(op);
    }
    if (interrupted.length) {
      const del = this.db.prepare('DELETE FROM staging WHERE operation_id=?');
      const setMeta = this.db.prepare("INSERT OR REPLACE INTO meta(key,value) VALUES('recovery-log',?)");
      const logs = interrupted.map((op) => `${op.kind}:${op.operationId}@stage${op.stage}`);
      setMeta.run(JSON.stringify({ at: new Date().toISOString(), rolledBack: logs }));
      const tx = this.db.prepare('DELETE FROM staging');
      tx.run();
    }
    return interrupted;
  }

  putBlob(sha256: string, bytes: Buffer) {
    this.db.prepare('INSERT OR IGNORE INTO blobs(sha256,bytes) VALUES(?,?)').run(sha256, bytes);
  }
  getBlob(sha256: string): Buffer | undefined {
    const row = this.db.prepare('SELECT bytes FROM blobs WHERE sha256=?').get(sha256) as { bytes?: Buffer } | undefined;
    return row?.bytes;
  }

  putProject(p: Project) {
    this.db.prepare('INSERT OR REPLACE INTO projects(id,name,case_pack_version,created_at,data) VALUES(?,?,?,?,?)')
      .run(p.id, p.name, p.casePackVersion, p.createdAt, JSON.stringify(p));
  }
  getProject(id: string): Project | null {
    const r = this.db.prepare('SELECT data FROM projects WHERE id=?').get(id) as { data?: string } | undefined;
    return r ? JSON.parse(r.data!) : null;
  }
  listProjects(): Project[] {
    return (this.db.prepare('SELECT data FROM projects').all() as { data: string }[]).map((r) => JSON.parse(r.data));
  }

  putBranch(b: Branch & { seqCounter?: number }) {
    this.db.prepare(`INSERT OR REPLACE INTO branches(id,project_id,name,head_event_id,forked_from_event_id,purpose,seq_counter,data)
      VALUES(?,?,?,?,?,?,?,?)`).run(
      b.id, b.projectId, b.name, b.headEventId, b.forkedFromEventId, b.purpose, b.seqCounter ?? 0, JSON.stringify(b),
    );
  }
  getBranch(id: string): (Branch & { seqCounter: number }) | null {
    const r = this.db.prepare('SELECT data, seq_counter FROM branches WHERE id=?').get(id) as { data: string; seq_counter: number } | undefined;
    if (!r) return null;
    return { ...JSON.parse(r.data), seqCounter: r.seq_counter };
  }
  listBranches(projectId: string): Branch[] {
    return (this.db.prepare('SELECT data FROM branches WHERE project_id=? ORDER BY rowid').all(projectId) as { data: string }[])
      .map((r) => JSON.parse(r.data));
  }

  putMaterial(projectId: string, m: Material) {
    this.db.prepare('INSERT OR REPLACE INTO materials(id,project_id,kind,data) VALUES(?,?,?,?)')
      .run(m.id, projectId, m.type, JSON.stringify(m));
  }
  getMaterial(projectId: string, id: string): Material | null {
    const r = this.db.prepare('SELECT data FROM materials WHERE project_id=? AND id=?').get(projectId, id) as { data?: string } | undefined;
    return r ? JSON.parse(r.data!) : null;
  }
  listMaterials(projectId: string): Material[] {
    return (this.db.prepare('SELECT data FROM materials WHERE project_id=? ORDER BY rowid').all(projectId) as { data: string }[])
      .map((r) => JSON.parse(r.data));
  }

  private makeEvent(projectId: string, branchId: string, seq: number, parentId: string | null,
      type: EventType, payload: unknown, creator: string, createdAt: string): Event {
    const id = contentId('evt', [projectId, branchId, seq, type, JSON.stringify(payload), parentId]);
    return { id, projectId, branchId, seq, parentId, type, createdAt, creator, payload } as unknown as Event;
  }

  private insertEvent(event: Event) {
    this.db.prepare(`INSERT INTO events(id,project_id,branch_id,seq,parent_id,type,creator,created_at,payload)
      VALUES(?,?,?,?,?,?,?,?,?)`).run(
      event.id, event.projectId, event.branchId, event.seq, event.parentId,
      event.type, event.creator, event.createdAt, JSON.stringify(event.payload),
    );
  }

  // 仅追加事件（身份=分支+序号+父链+负载的内容哈希）；等价输入重放得到相同 id 与顺序
  appendEvent<T extends EventType>(projectId: string, branchId: string, type: T, payload: EventPayloadMap[T], creator = 'reviewer'): Event {
    const branch = this.getBranch(branchId);
    if (!branch) throw new Error(`unknown branch ${branchId}`);
    const seq = branch.seqCounter + 1;
    const event = this.makeEvent(projectId, branchId, seq, branch.headEventId, type, payload, creator, '2026-09-23T04:00:00+09:00');
    this.insertEvent(event);
    this.db.prepare('UPDATE branches SET head_event_id=?, seq_counter=? WHERE id=?').run(event.id, seq, branchId);
    return event;
  }

  // 从源分支在某事件处分叉：复制该点之前（含）事件到新分支，重算身份但保持顺序与负载
  forkBranch(projectId: string, newBranchId: string, name: string, purpose: string,
      sourceBranchId: string, uptoEventId: string): Branch {
    if (this.getBranch(newBranchId)) throw new Error(`branch ${newBranchId} exists`);
    const sourceEvents = this.listEvents(sourceBranchId);
    const cut = sourceEvents.findIndex((e) => e.id === uptoEventId);
    if (cut < 0) throw new Error('fork point not found');
    this.db.prepare(`INSERT INTO branches(id,project_id,name,head_event_id,forked_from_event_id,purpose,seq_counter)
      VALUES(?,?,?,?,?,?,?)`).run(newBranchId, projectId, name, null, uptoEventId, purpose, -1);
    let parentId: string | null = null;
    for (const src of sourceEvents.slice(0, cut + 1)) {
      const ev = this.makeEvent(projectId, newBranchId, src.seq, parentId, src.type, src.payload, src.creator, src.createdAt);
      this.insertEvent(ev);
      parentId = ev.id;
    }
    this.db.prepare('UPDATE branches SET head_event_id=?, seq_counter=? WHERE id=?')
      .run(parentId, cut, newBranchId);
    return this.getBranch(newBranchId)! as Branch;
  }

  listEvents(branchId: string): Event[] {
    return (this.db.prepare('SELECT * FROM events WHERE branch_id=? ORDER BY seq').all(branchId) as Record<string, unknown>[])
      .map((r) => ({
        id: r.id as string, projectId: r.project_id as string, branchId: r.branch_id as string,
        seq: r.seq as number, parentId: r.parent_id as string | null, type: r.type as EventType,
        creator: r.creator as string, createdAt: r.created_at as string,
        payload: JSON.parse(r.payload as string),
      })) as Event[];
  }

  saveComputations(projectId: string, branchId: string, seqAt: number, nodesJson: string) {
    this.db.prepare('DELETE FROM computations WHERE project_id=? AND branch_id=? AND seq_at=?')
      .run(projectId, branchId, seqAt);
    const nodes = JSON.parse(nodesJson) as { id: string }[];
    const ins = this.db.prepare('INSERT OR REPLACE INTO computations(id,project_id,branch_id,seq_at,node_json) VALUES(?,?,?,?,?)');
    for (const n of nodes) ins.run(n.id, projectId, branchId, seqAt, JSON.stringify(n));
  }
  getComputations(projectId: string, branchId: string, seqAt: number) {
    return (this.db.prepare('SELECT node_json FROM computations WHERE project_id=? AND branch_id=? AND seq_at=?')
      .all(projectId, branchId, seqAt) as { node_json: string }[]).map((r) => JSON.parse(r.node_json));
  }

  stageBegin(op: StagingOp) {
    this.db.prepare('INSERT OR REPLACE INTO staging(operation_id,project_id,kind,stage,created_at,payload) VALUES(?,?,?,?,?,?)')
      .run(op.operationId, op.projectId, op.kind, op.stage, op.createdAt, JSON.stringify(op.payload));
  }
  stageAdvance(operationId: string, stage: number) {
    this.db.prepare('UPDATE staging SET stage=? WHERE operation_id=?').run(stage, operationId);
  }
  stageDone(operationId: string) {
    this.db.prepare('DELETE FROM staging WHERE operation_id=?').run(operationId);
  }
  getMeta(key: string): string | null {
    return (this.db.prepare('SELECT value FROM meta WHERE key=?').get(key) as { value?: string } | undefined)?.value ?? null;
  }

  deleteProject(projectId: string) {
    this.db.prepare('DELETE FROM events WHERE project_id=?').run(projectId);
    this.db.prepare('DELETE FROM branches WHERE project_id=?').run(projectId);
    this.db.prepare('DELETE FROM materials WHERE project_id=?').run(projectId);
    this.db.prepare('DELETE FROM computations WHERE project_id=?').run(projectId);
    this.db.prepare('DELETE FROM projects WHERE id=?').run(projectId);
  }

  close() { this.db.close(); }
}

export function hashBytes(bytes: Buffer) { return sha256Hex(bytes); }
export function readCasePackFile(rel: string) { return readFileSync(rel); }
