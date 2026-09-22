/**
 * SQLite 存储层（可被测试直接调用，不经过 HTTP）。
 * 表：projects / events / materials_rev / lanes_rev / bands_rev /
 *     results / blobs / branches / journal。
 * 事件 append-only；结果按内容哈希只增不改。
 */
import Database from 'better-sqlite3';
import type { Database as DB } from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type {
  BandCenterRevision,
  BranchSpec,
  ComputeResult,
  CounterexampleEntry,
  EventRecord,
  LaneGeometryRevision,
  Material
} from '../core/types.js';

export interface ProjectRow {
  id: string;
  name: string;
  main_branch_id: string;
  current_image_identity: string;
  ladder_lane_identity: string;
  lane_labels: string;
  counterexamples: string;
  created_at: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  main_branch_id TEXT NOT NULL,
  current_image_identity TEXT NOT NULL,
  ladder_lane_identity TEXT NOT NULL,
  lane_labels TEXT NOT NULL,
  counterexamples TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS branches (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  spec TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS events (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  branch_id TEXT NOT NULL,
  parent_event_id TEXT,
  type TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  input_summary TEXT NOT NULL,
  param_version TEXT NOT NULL,
  parents TEXT NOT NULL,
  result_id TEXT,
  outcome_class TEXT,
  decision TEXT,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS materials_rev (
  project_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  revision INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, identity, revision)
);
CREATE TABLE IF NOT EXISTS lanes_rev (
  project_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  revision INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, identity, revision)
);
CREATE TABLE IF NOT EXISTS bands_rev (
  project_id TEXT NOT NULL,
  identity TEXT NOT NULL,
  revision INTEGER NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, identity, revision)
);
CREATE TABLE IF NOT EXISTS results (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  json TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS blobs (
  project_id TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  bytes BLOB NOT NULL,
  PRIMARY KEY (project_id, blob_id)
);
CREATE TABLE IF NOT EXISTS blob_index (
  project_id TEXT NOT NULL,
  sha256 TEXT NOT NULL,
  blob_id TEXT NOT NULL,
  media_type TEXT NOT NULL,
  width INTEGER NOT NULL,
  height INTEGER NOT NULL,
  PRIMARY KEY (project_id, sha256)
);
-- 半写恢复：导入前登记事务意图，提交后清除；重启时未清除即回滚
CREATE TABLE IF NOT EXISTS journal (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  phase TEXT NOT NULL,
  started_at TEXT NOT NULL,
  detail TEXT NOT NULL DEFAULT '{}'
);
`;

export function openDatabase(pathOrMemory: string = ':memory:'): DB {
  if (pathOrMemory !== ':memory:') mkdirSync(dirname(pathOrMemory), { recursive: true });
  const db = new Database(pathOrMemory);
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  recoverInterrupted(db);
  return db;
}

/** 半写恢复：发现未完成的导入/保存事务，回滚并返回诊断信息 */
export function recoverInterrupted(db: DB): { recovered: boolean; phase: string | null } {
  const row = db.prepare('SELECT phase, started_at, detail FROM journal WHERE id = 1').get() as
    | { phase: string; started_at: string; detail: string }
    | undefined;
  if (!row) return { recovered: false, phase: null };
  // WAL 下未提交事务随连接关闭已回滚；journal 行作为显式意图记录，清除并上报
  db.prepare('DELETE FROM journal WHERE id = 1').run();
  return { recovered: true, phase: row.phase };
}

export function beginIntent(db: DB, phase: string, detail: unknown = {}): void {
  db.prepare('INSERT OR REPLACE INTO journal (id, phase, started_at, detail) VALUES (1, ?, ?, ?)').run(
    phase,
    new Date(0).toISOString(),
    JSON.stringify(detail)
  );
}

export function clearIntent(db: DB): void {
  db.prepare('DELETE FROM journal WHERE id = 1').run();
}

export class ProjectStore {
  constructor(private readonly db: DB) {}

  listProjects(): ProjectRow[] {
    return this.db.prepare('SELECT * FROM projects ORDER BY created_at').all() as ProjectRow[];
  }

  getProject(id: string): ProjectRow | undefined {
    return this.db.prepare('SELECT * FROM projects WHERE id = ?').get(id) as ProjectRow | undefined;
  }

  projectExists(id: string): boolean {
    return !!this.db.prepare('SELECT 1 FROM projects WHERE id = ?').get(id);
  }

  createProject(row: Omit<ProjectRow, 'counterexamples'> & { counterexamples?: CounterexampleEntry[] }): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, main_branch_id, current_image_identity,
           ladder_lane_identity, lane_labels, counterexamples, created_at)
         VALUES (@id, @name, @main_branch_id, @current_image_identity,
           @ladder_lane_identity, @lane_labels, @counterexamples, @created_at)`
      )
      .run({
        ...row,
        lane_labels: JSON.stringify(row.lane_labels),
        counterexamples: JSON.stringify(row.counterexamples ?? [])
      });
  }

  updateProjectMeta(
    id: string,
    patch: Partial<Pick<ProjectRow, 'name' | 'current_image_identity'>> & {
      counterexamples?: CounterexampleEntry[] | string;
    }
  ): void {
    const sets: string[] = [];
    const vals: unknown[] = [];
    for (const [k, v] of Object.entries(patch)) {
      sets.push(`${k} = ?`);
      vals.push(k === 'counterexamples' ? JSON.stringify(v) : v);
    }
    vals.push(id);
    this.db.prepare(`UPDATE projects SET ${sets.join(', ')} WHERE id = ?`).run(...vals);
  }

  addBranch(projectId: string, spec: BranchSpec): void {
    this.db
      .prepare('INSERT OR REPLACE INTO branches (project_id, id, spec) VALUES (?, ?, ?)')
      .run(projectId, spec.id, JSON.stringify(spec));
  }

  getBranches(projectId: string): BranchSpec[] {
    const rows = this.db.prepare('SELECT spec FROM branches WHERE project_id = ?').all(projectId) as {
      spec: string;
    }[];
    return rows.map((r) => JSON.parse(r.spec) as BranchSpec);
  }

  appendEvent(projectId: string, ev: EventRecord): void {
    this.db
      .prepare(
        `INSERT INTO events (project_id, id, seq, branch_id, parent_event_id, type, actor,
           payload, input_summary, param_version, parents, result_id, outcome_class, decision)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        projectId,
        ev.id,
        ev.seq,
        ev.branchId,
        ev.parentEventId,
        ev.type,
        ev.actor,
        JSON.stringify(ev.payload),
        JSON.stringify(ev.inputSummary),
        ev.paramVersion,
        JSON.stringify(ev.parents),
        ev.resultId,
        ev.outcomeClass ?? null,
        ev.decision ? JSON.stringify(ev.decision) : null
      );
  }

  getEvents(projectId: string): EventRecord[] {
    const rows = this.db
      .prepare('SELECT * FROM events WHERE project_id = ? ORDER BY seq')
      .all(projectId) as Record<string, unknown>[];
    return rows.map(deserializeEvent);
  }

  nextSeq(projectId: string): number {
    const row = this.db
      .prepare('SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE project_id = ?')
      .get(projectId) as { m: number };
    return row.m + 1;
  }

  putMaterial(projectId: string, m: Material): void {
    this.db
      .prepare(
        'INSERT OR REPLACE INTO materials_rev (project_id, identity, revision, json) VALUES (?, ?, ?, ?)'
      )
      .run(projectId, m.identity, m.revision, JSON.stringify(m));
  }
  putLane(projectId: string, l: LaneGeometryRevision): void {
    this.db
      .prepare('INSERT OR REPLACE INTO lanes_rev (project_id, identity, revision, json) VALUES (?, ?, ?, ?)')
      .run(projectId, l.identity, l.revision, JSON.stringify(l));
  }
  putBand(projectId: string, b: BandCenterRevision): void {
    this.db
      .prepare('INSERT OR REPLACE INTO bands_rev (project_id, identity, revision, json) VALUES (?, ?, ?, ?)')
      .run(projectId, b.identity, b.revision, JSON.stringify(b));
  }
  putResult(projectId: string, r: ComputeResult): void {
    this.db
      .prepare('INSERT OR IGNORE INTO results (project_id, id, json) VALUES (?, ?, ?)')
      .run(projectId, r.id, JSON.stringify(r));
  }
  getResult(projectId: string, id: string): ComputeResult | undefined {
    const row = this.db
      .prepare('SELECT json FROM results WHERE project_id = ? AND id = ?')
      .get(projectId, id) as { json: string } | undefined;
    return row ? (JSON.parse(row.json) as ComputeResult) : undefined;
  }

  getAllMaterials(projectId: string): Material[] {
    return (this.db.prepare('SELECT json FROM materials_rev WHERE project_id = ?').all(projectId) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as Material
    );
  }
  getAllLanes(projectId: string): LaneGeometryRevision[] {
    return (this.db.prepare('SELECT json FROM lanes_rev WHERE project_id = ?').all(projectId) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as LaneGeometryRevision
    );
  }
  getAllBands(projectId: string): BandCenterRevision[] {
    return (this.db.prepare('SELECT json FROM bands_rev WHERE project_id = ?').all(projectId) as { json: string }[]).map(
      (r) => JSON.parse(r.json) as BandCenterRevision
    );
  }

  putBlob(projectId: string, blobId: string, sha256: string, bytes: Uint8Array): void {
    this.db
      .prepare('INSERT OR IGNORE INTO blobs (project_id, blob_id, sha256, bytes) VALUES (?, ?, ?, ?)')
      .run(projectId, blobId, sha256, Buffer.from(bytes));
  }
  getBlobBySha(projectId: string, sha256: string): { bytes: Uint8Array; blobId: string } | undefined {
    const row = this.db
      .prepare('SELECT blob_id, bytes FROM blobs WHERE project_id = ? AND sha256 = ?')
      .get(projectId, sha256) as { blob_id: string; bytes: Buffer } | undefined;
    return row ? { bytes: new Uint8Array(row.bytes), blobId: row.blob_id } : undefined;
  }

  deleteProject(projectId: string): void {
    const tx = this.db.transaction((id: string) => {
      for (const t of [
        'events',
        'materials_rev',
        'lanes_rev',
        'bands_rev',
        'results',
        'blobs',
        'blob_index',
        'branches',
        'projects'
      ]) {
        this.db.prepare(`DELETE FROM ${t} WHERE project_id = ?`).run(id);
      }
    });
    tx(projectId);
  }
}

export function deserializeEvent(row: Record<string, unknown>): EventRecord {
  return {
    id: row.id as string,
    seq: Number(row.seq),
    projectId: row.project_id as string,
    branchId: row.branch_id as string,
    parentEventId: (row.parent_event_id as string) ?? null,
    type: row.type as EventRecord['type'],
    actor: row.actor as EventRecord['actor'],
    payload: JSON.parse(row.payload as string),
    inputSummary: JSON.parse((row.input_summary as string) || '{}'),
    paramVersion: row.param_version as string,
    parents: JSON.parse((row.parents as string) || '[]'),
    resultId: (row.result_id as string) ?? null,
    outcomeClass: (row.outcome_class as EventRecord['outcomeClass']) ?? undefined,
    decision: row.decision ? JSON.parse(row.decision as string) : undefined
  };
}
