import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let sqliteApi: typeof import('node:sqlite') | undefined;
async function loadSqlite(): Promise<typeof import('node:sqlite')> {
  if (!sqliteApi) sqliteApi = await import('node:sqlite');
  return sqliteApi;
}

export interface EventRow {
  id: string;
  project_id: string;
  seq: number;
  branch: string;
  parent_event_id: string | null;
  type: string;
  at: string;
  actor: string;
  message: string;
  payload_json: string;
}

export interface BlobRow {
  id: string;
  bytes: Buffer;
  sha256: string;
}

export interface KeyRow {
  k: string;
  v: string;
}

const SCHEMA = `
PRAGMA journal_mode = WAL;
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  head_json TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  bytes BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  branch TEXT NOT NULL,
  parent_event_id TEXT,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  message TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  UNIQUE(project_id, branch, seq)
);
CREATE TABLE IF NOT EXISTS results (
  event_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  output_json TEXT NOT NULL,
  materials_json TEXT NOT NULL,
  PRIMARY KEY (event_id)
);
CREATE TABLE IF NOT EXISTS kv (
  k TEXT PRIMARY KEY,
  v TEXT NOT NULL
);
`;

export class GelStore {
  private db!: DatabaseSync;
  private path: string;

  constructor(path: string) {
    this.path = path;
  }

  static async open(path: string): Promise<GelStore> {
    const store = new GelStore(path);
    await store.init();
    return store;
  }

  async init(): Promise<void> {
    const sqlite = await loadSqlite();
    mkdirSync(dirname(this.path), { recursive: true });
    this.db = new sqlite.DatabaseSync(this.path);
    this.db.exec(SCHEMA);
  }

  runInTransaction<T>(fn: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const out = fn();
      this.db.exec('COMMIT');
      return out;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  /** 模拟写一半崩溃：在写完事件后、写结果前崩溃，事务回滚。 */
  crashMidwaySimulation(projectId: string, event: EventRow): never {
    this.db.exec('BEGIN IMMEDIATE');
    this.db
      .prepare(
        `INSERT INTO events (id, project_id, seq, branch, parent_event_id, type, at, actor, message, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.project_id,
        event.seq,
        event.branch,
        event.parent_event_id,
        event.type,
        event.at,
        event.actor,
        event.message,
        event.payload_json,
      );
    // 故意不 COMMIT：进程级回滚由 ROLLBACK/连接关闭完成
    this.db.exec('ROLLBACK');
    throw Object.assign(new Error('SIMULATED_HALF_WRITE'), { simulated: true });
  }

  upsertProject(row: { id: string; name: string; created_at: string; head_json: string }): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, name, created_at, head_json) VALUES (?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET name=excluded.name, head_json=excluded.head_json`,
      )
      .run(row.id, row.name, row.created_at, row.head_json);
  }

  setProjectHead(id: string, headJson: string): void {
    this.db.prepare('UPDATE projects SET head_json=? WHERE id=?').run(headJson, id);
  }

  getProject(id: string): { id: string; name: string; created_at: string; head_json: string } | undefined {
    const row = this.db
      .prepare('SELECT id, name, created_at, head_json FROM projects WHERE id=?')
      .get(id) as
      | { id: string; name: string; created_at: string; head_json: string }
      | undefined;
    return row;
  }

  listProjects(): { id: string; name: string; created_at: string }[] {
    return this.db
      .prepare('SELECT id, name, created_at FROM projects ORDER BY created_at, id')
      .all() as { id: string; name: string; created_at: string }[];
  }

  deleteProject(id: string): void {
    this.runInTransaction(() => {
      this.db.prepare('DELETE FROM results WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM events WHERE project_id=?').run(id);
      this.db.prepare('DELETE FROM projects WHERE id=?').run(id);
    });
  }

  insertBlob(blob: BlobRow): void {
    this.db
      .prepare('INSERT OR IGNORE INTO blobs (id, sha256, bytes) VALUES (?, ?, ?)')
      .run(blob.id, blob.sha256, Buffer.from(blob.bytes));
  }

  getBlob(id: string): BlobRow | undefined {
    const row = this.db.prepare('SELECT id, sha256, bytes FROM blobs WHERE id=?').get(id) as
      | BlobRow
      | undefined;
    return row;
  }

  appendEvent(event: EventRow): void {
    this.db
      .prepare(
        `INSERT INTO events (id, project_id, seq, branch, parent_event_id, type, at, actor, message, payload_json)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.id,
        event.project_id,
        event.seq,
        event.branch,
        event.parent_event_id,
        event.type,
        event.at,
        event.actor,
        event.message,
        event.payload_json,
      );
  }

  listEvents(projectId: string): EventRow[] {
    return this.db
      .prepare('SELECT * FROM events WHERE project_id=? ORDER BY seq, id')
      .all(projectId) as unknown as EventRow[];
  }

  putResult(eventId: string, projectId: string, outputJson: string, materialsJson: string): void {
    this.db
      .prepare(
        `INSERT INTO results (event_id, project_id, output_json, materials_json)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(event_id) DO UPDATE SET output_json=excluded.output_json, materials_json=excluded.materials_json`,
      )
      .run(eventId, projectId, outputJson, materialsJson);
  }

  getResult(eventId: string): { output_json: string; materials_json: string } | undefined {
    return this.db
      .prepare('SELECT output_json, materials_json FROM results WHERE event_id=?')
      .get(eventId) as { output_json: string; materials_json: string } | undefined;
  }

  setKey(k: string, v: string): void {
    this.db
      .prepare('INSERT INTO kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v')
      .run(k, v);
  }

  getKey(k: string): string | undefined {
    return (this.db.prepare('SELECT v FROM kv WHERE k=?').get(k) as KeyRow | undefined)?.v;
  }

  close(): void {
    this.db.close();
  }
}
