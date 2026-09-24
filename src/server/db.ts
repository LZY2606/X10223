// SQLite 存储层：材料、事件、派生结果分表；所有多行写入在事务内完成，
// meta.last_committed_seq 作为提交标记，打开时校验并回滚半写。
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { GelEvent, Material, Project, Result } from '../shared/types.js';

export interface RecoveryReport {
  recovered: boolean;
  rolledBackEvents: number;
  detail: string;
}

export function openDb(path: string): { db: Database.Database; recovery: RecoveryReport } {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS projects(
      id TEXT PRIMARY KEY, name TEXT NOT NULL, kind TEXT NOT NULL,
      scenario TEXT NOT NULL, created_seq INTEGER NOT NULL);
    CREATE TABLE IF NOT EXISTS materials(
      id TEXT NOT NULL, version INTEGER NOT NULL, project_id TEXT NOT NULL,
      type TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER,
      content_hash TEXT NOT NULL, payload TEXT NOT NULL,
      PRIMARY KEY(id, version));
    CREATE TABLE IF NOT EXISTS events(
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL, project_id TEXT NOT NULL, type TEXT NOT NULL,
      parents TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL);
    CREATE TABLE IF NOT EXISTS results(
      id TEXT NOT NULL, version INTEGER NOT NULL, project_id TEXT NOT NULL,
      kind TEXT NOT NULL, valid_from INTEGER NOT NULL, valid_to INTEGER,
      input_digest TEXT NOT NULL, param_version TEXT NOT NULL,
      parents TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL,
      diagnostics TEXT NOT NULL, PRIMARY KEY(id, version));
    CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, seq);
    CREATE INDEX IF NOT EXISTS idx_results_project ON results(project_id, kind);
  `);
  const recovery = recoverHalfWrite(db);
  return { db, recovery };
}

// 半写恢复：events 最大序号超过提交标记 => 上次写入中断，回滚未提交部分。
function recoverHalfWrite(db: Database.Database): RecoveryReport {
  const row = db.prepare(`SELECT value FROM meta WHERE key='last_committed_seq'`).get() as { value: string } | undefined;
  const committed = Number(row?.value ?? '0');
  const maxSeq = (db.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM events`).get() as { m: number }).m;
  if (maxSeq <= committed) {
    return { recovered: false, rolledBackEvents: 0, detail: `consistent at seq ${committed}` };
  }
  const orphans = db.prepare(`SELECT seq FROM events WHERE seq > ?`).all(committed) as Array<{ seq: number }>;
  const tx = db.transaction(() => {
    db.prepare(`DELETE FROM events WHERE seq > ?`).run(committed);
    db.prepare(`DELETE FROM results WHERE valid_from > ?`).run(committed);
    db.prepare(`UPDATE results SET valid_to = NULL WHERE valid_to > ?`).run(committed);
    db.prepare(`DELETE FROM materials WHERE valid_from > ?`).run(committed);
    db.prepare(`UPDATE materials SET valid_to = NULL WHERE valid_to > ?`).run(committed);
  });
  tx();
  return { recovered: true, rolledBackEvents: orphans.length, detail: `rolled back ${orphans.length} uncommitted event(s) beyond seq ${committed}` };
}

export class Repo {
  constructor(public db: Database.Database) {}

  nextSeq(): number {
    return (this.db.prepare(`SELECT COALESCE(MAX(seq),0) AS m FROM events`).get() as { m: number }).m + 1;
  }

  insertProject(p: Project): void {
    this.db.prepare(`INSERT INTO projects(id,name,kind,scenario,created_seq) VALUES (?,?,?,?,?)`)
      .run(p.id, p.name, p.kind, p.scenario, p.createdSeq);
  }

  appendEvent(e: Omit<GelEvent, 'seq'>, seq: number): void {
    this.db.prepare(`INSERT INTO events(seq,id,project_id,type,parents,payload,created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(seq, e.id, e.projectId, e.type, JSON.stringify(e.parents), JSON.stringify(e.payload), e.createdAt);
  }

  putMaterial(m: Material, projectId: string): void {
    this.db.prepare(`INSERT INTO materials(id,version,project_id,type,valid_from,valid_to,content_hash,payload) VALUES (?,?,?,?,?,?,?,?)`)
      .run(m.id, m.version, projectId, m.type, m.validFrom, m.validTo, m.contentHash, JSON.stringify(m.payload));
  }

  closeMaterial(id: string, version: number, validTo: number): void {
    this.db.prepare(`UPDATE materials SET valid_to=? WHERE id=? AND version=?`).run(validTo, id, version);
  }

  putResult(r: Result, projectId: string): void {
    this.db.prepare(`INSERT INTO results(id,version,project_id,kind,valid_from,valid_to,input_digest,param_version,parents,status,payload,diagnostics) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`)
      .run(r.id, r.version, projectId, r.kind, r.validFrom, r.validTo, r.inputDigest, r.paramVersion,
        JSON.stringify(r.parents), r.status, JSON.stringify(r.payload), JSON.stringify(r.diagnostics));
  }

  closeResult(id: string, version: number, validTo: number): void {
    this.db.prepare(`UPDATE results SET valid_to=? WHERE id=? AND version=?`).run(validTo, id, version);
  }

  commitMarker(seq: number): void {
    this.db.prepare(`INSERT INTO meta(key,value) VALUES('last_committed_seq',?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`)
      .run(String(seq));
  }

  // 一次完整的状态推进：事件 + 新材料版本 + 新结果版本 + 提交标记，全在一个事务里。
  advance(fn: (seq: number) => void): number {
    const seq = this.nextSeq();
    const tx = this.db.transaction(() => {
      fn(seq);
      this.commitMarker(seq);
    });
    tx();
    return seq;
  }

  projects(): Project[] {
    return (this.db.prepare(`SELECT * FROM projects ORDER BY created_seq, id`).all() as Array<Record<string, unknown>>)
      .map((r) => ({ id: r.id, name: r.name, kind: r.kind, scenario: r.scenario, createdSeq: r.created_seq } as Project));
  }

  events(projectId: string, atSeq?: number): GelEvent[] {
    const rows = this.db.prepare(`SELECT * FROM events WHERE project_id=? AND seq<=? ORDER BY seq`)
      .all(projectId, atSeq ?? Number.MAX_SAFE_INTEGER) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      seq: r.seq, id: r.id, projectId: r.project_id, type: r.type,
      parents: JSON.parse(r.parents as string), payload: JSON.parse(r.payload as string), createdAt: r.created_at,
    } as GelEvent));
  }

  materials(projectId: string, atSeq?: number): Material[] {
    const seq = atSeq ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db.prepare(
      `SELECT * FROM materials WHERE project_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?) ORDER BY id, version`
    ).all(projectId, seq, seq) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id, version: r.version, type: r.type, validFrom: r.valid_from, validTo: r.valid_to,
      contentHash: r.content_hash, payload: JSON.parse(r.payload as string),
    } as Material));
  }

  results(projectId: string, kind?: string, atSeq?: number): Result[] {
    const seq = atSeq ?? Number.MAX_SAFE_INTEGER;
    const rows = this.db.prepare(
      `SELECT * FROM results WHERE project_id=? AND valid_from<=? AND (valid_to IS NULL OR valid_to>?) ${kind ? 'AND kind=?' : ''} ORDER BY id, version`
    ).all(...(kind ? [projectId, seq, seq, kind] : [projectId, seq, seq])) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id, version: r.version, kind: r.kind, validFrom: r.valid_from, validTo: r.valid_to,
      inputDigest: r.input_digest, paramVersion: r.param_version, parents: JSON.parse(r.parents as string),
      status: r.status, payload: JSON.parse(r.payload as string), diagnostics: JSON.parse(r.diagnostics as string),
    } as Result));
  }

  allResultsEver(projectId: string): Result[] {
    const rows = this.db.prepare(`SELECT * FROM results WHERE project_id=? ORDER BY id, version`).all(projectId) as Array<Record<string, unknown>>;
    return rows.map((r) => ({
      id: r.id, version: r.version, kind: r.kind, validFrom: r.valid_from, validTo: r.valid_to,
      inputDigest: r.input_digest, paramVersion: r.param_version, parents: JSON.parse(r.parents as string),
      status: r.status, payload: JSON.parse(r.payload as string), diagnostics: JSON.parse(r.diagnostics as string),
    } as Result));
  }
}
