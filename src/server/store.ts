import { createRequire } from 'node:module';
// 通过 CJS require 加载实验内置，避免打包器剥离 node: 前缀。
const sqlite = createRequire(import.meta.url)('node:sqlite') as typeof import('node:sqlite');
const DatabaseSyncImpl = sqlite.DatabaseSync;
// @ts-expect-error 实验内置实例类型
type DatabaseSync = sqlite.DatabaseSync;
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { CorruptFormatError } from '../shared/diagnostic';

/**
 * SQLite 存储层。
 * - 材料大对象单独存 blob（灰度原图、PNG）。
 * - 事件以规范 JSON 存储，自校验链。
 * - 半写恢复：事件先写 pending，提交标记成功后才并入 events；
 *   启动时把残留 pending 回滚（除非显式 resume）。
 */
export class GelStore {
  readonly db: DatabaseSync;

  constructor(path: string, opts: { recoverOnOpen?: boolean } = { recoverOnOpen: true }) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSyncImpl(path);
    this.db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
    this.init();
    if (opts.recoverOnOpen !== false) this.recoverPending();
  }

  private init() {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS projects (
        project_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_at TEXT NOT NULL,
        state_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS materials (
        project_id TEXT NOT NULL,
        material_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        json_meta TEXT NOT NULL,
        blob BLOB,
        PRIMARY KEY (project_id, material_id)
      );
      CREATE TABLE IF NOT EXISTS events (
        project_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        event_id TEXT PRIMARY KEY,
        branch_id TEXT NOT NULL,
        event_json TEXT NOT NULL,
        self_hash TEXT NOT NULL,
        prev_hash TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS event_pending (
        project_id TEXT NOT NULL,
        token TEXT NOT NULL,
        event_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (project_id, token)
      );
      CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL);
    `);
  }

  listProjects(): { projectId: string; name: string; updatedAt: string }[] {
    return this.db
      .prepare('SELECT project_id projectId, name, updated_at updatedAt FROM projects ORDER BY created_at')
      .all() as { projectId: string; name: string; updatedAt: string }[];
  }

  saveProjectState(projectId: string, name: string, createdAt: string, stateJson: string) {
    this.db
      .prepare(
        `INSERT INTO projects(project_id,name,created_at,state_json,updated_at)
         VALUES(?,?,?,?,?)
         ON CONFLICT(project_id) DO UPDATE SET name=excluded.name, state_json=excluded.state_json, updated_at=excluded.updated_at`,
      )
      .run(projectId, name, createdAt, stateJson, new Date().toISOString());
  }

  getStateJson(projectId: string): string | null {
    const row = this.db.prepare('SELECT state_json s FROM projects WHERE project_id=?').get(projectId) as
      | { s: string }
      | undefined;
    return row?.s ?? null;
  }

  putMaterial(projectId: string, materialId: string, kind: string, jsonMeta: string, blob?: Uint8Array) {
    this.db
      .prepare(
        `INSERT INTO materials(project_id,material_id,kind,json_meta,blob) VALUES(?,?,?,?,?)
         ON CONFLICT(project_id,material_id) DO UPDATE SET kind=excluded.kind, json_meta=excluded.json_meta, blob=excluded.blob`,
      )
      .run(projectId, materialId, kind, jsonMeta, blob ? Buffer.from(blob) : null);
  }

  getMaterialBlob(projectId: string, materialId: string): Uint8Array | null {
    const row = this.db
      .prepare('SELECT blob FROM materials WHERE project_id=? AND material_id=?')
      .get(projectId, materialId) as { blob: Uint8Array | null } | undefined;
    return row?.blob ?? null;
  }

  getMaterialMeta(projectId: string, materialId: string): string | null {
    const row = this.db
      .prepare('SELECT json_meta j FROM materials WHERE project_id=? AND material_id=?')
      .get(projectId, materialId) as { j: string } | undefined;
    return row?.j ?? null;
  }

  /** 半写两阶段：先暂存。 */
  stageEvent(projectId: string, token: string, eventJson: string) {
    this.db
      .prepare('INSERT OR REPLACE INTO event_pending(project_id,token,event_json,created_at) VALUES(?,?,?,?)')
      .run(projectId, token, eventJson, new Date().toISOString());
  }

  commitEvent(projectId: string, seq: number, eventId: string, branchId: string, eventJson: string, selfHash: string, prevHash: string, token: string) {
    const tx = this.db.prepare(
      `INSERT INTO events(project_id,seq,event_id,branch_id,event_json,self_hash,prev_hash)
       VALUES(?,?,?,?,?,?,?)`,
    );
    const del = this.db.prepare('DELETE FROM event_pending WHERE project_id=? AND token=?');
    const info = this.db.prepare('SELECT event_json j FROM event_pending WHERE project_id=? AND token=?').get(projectId, token) as { j: string } | undefined;
    if (!info || info.j !== eventJson) {
      throw new CorruptFormatError('提交的事件与暂存内容不一致（疑似半写）');
    }
    this.db.exec('BEGIN');
    try {
      tx.run(projectId, seq, eventId, branchId, eventJson, selfHash, prevHash);
      del.run(projectId, token);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
  }

  /** 恢复：未提交的暂存视为半写，回滚。 */
  recoverPending(): { rolledBack: number } {
    const rows = this.db.prepare('SELECT COUNT(*) c FROM event_pending').get() as { c: number };
    this.db.exec('DELETE FROM event_pending');
    return { rolledBack: rows.c ?? 0 };
  }

  listEvents(projectId: string): string[] {
    const rows = this.db
      .prepare('SELECT event_json j FROM events WHERE project_id=? ORDER BY seq')
      .all(projectId) as { j: string }[];
    return rows.map((r) => r.j);
  }

  verifyChain(projectId: string): { ok: boolean; brokenAt?: string } {
    const rows = this.db
      .prepare('SELECT event_id id, self_hash h, prev_hash p FROM events WHERE project_id=? ORDER BY seq')
      .all(projectId) as { id: string; h: string; p: string }[];
    let prev = '';
    for (const r of rows) {
      if (r.p !== prev) return { ok: false, brokenAt: r.id };
      prev = r.h;
    }
    return { ok: true };
  }

  close() {
    this.db.close();
  }
}
