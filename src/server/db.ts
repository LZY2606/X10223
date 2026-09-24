/** SQLite 存储层（node:sqlite）。半写恢复：所有多步写入包裹在事务中，
 *  未完成的事务由 staging 表在启动时清理。 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

export interface EventRow {
  id: string; seq: number; project_id: string; branch: string;
  parent_event_id: string | null; type: string; payload: string;
  depends_on: string; params_version: string; created_at: string;
}

export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY, name TEXT NOT NULL, created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS events (
        id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL,
        project_id TEXT NOT NULL,
        branch TEXT NOT NULL,
        parent_event_id TEXT,
        type TEXT NOT NULL,
        payload TEXT NOT NULL,
        depends_on TEXT NOT NULL,
        params_version TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE(project_id, seq)
      );
      CREATE TABLE IF NOT EXISTS blobs (
        hash TEXT PRIMARY KEY, data BLOB NOT NULL, media_type TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS staging (
        token TEXT PRIMARY KEY, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at TEXT NOT NULL
      );
    `);
    this.recoverHalfWrites();
  }

  /** 半写恢复：启动时清理未完成的 staging 记录 */
  private recoverHalfWrites(): void {
    const rows = this.db.prepare("SELECT token, kind FROM staging").all() as { token: string; kind: string }[];
    for (const r of rows) {
      this.db.prepare("DELETE FROM staging WHERE token = ?").run(r.token);
    }
  }

  beginStaging(token: string, kind: string, payload: string): void {
    this.db.prepare("INSERT INTO staging (token, kind, payload, created_at) VALUES (?, ?, ?, ?)")
      .run(token, kind, payload, new Date().toISOString());
  }

  commitStaging(token: string): void {
    this.db.prepare("DELETE FROM staging WHERE token = ?").run(token);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  nextSeq(projectId: string): number {
    const row = this.db.prepare("SELECT COALESCE(MAX(seq), 0) + 1 AS n FROM events WHERE project_id = ?")
      .get(projectId) as { n: number };
    return row.n;
  }

  insertEvent(e: EventRow): void {
    this.db.prepare(`INSERT INTO events (id, seq, project_id, branch, parent_event_id, type, payload, depends_on, params_version, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(e.id, e.seq, e.project_id, e.branch, e.parent_event_id, e.type, e.payload, e.depends_on, e.params_version, e.created_at);
  }

  eventsOf(projectId: string): EventRow[] {
    return this.db.prepare("SELECT * FROM events WHERE project_id = ? ORDER BY seq, id").all(projectId) as EventRow[];
  }

  putBlob(hash: string, data: Buffer, mediaType: string): void {
    this.db.prepare("INSERT OR IGNORE INTO blobs (hash, data, media_type) VALUES (?, ?, ?)").run(hash, data, mediaType);
  }

  getBlob(hash: string): { data: Buffer; mediaType: string } | null {
    const row = this.db.prepare("SELECT data, media_type FROM blobs WHERE hash = ?").get(hash) as
      | { data: Buffer; media_type: string } | undefined;
    return row ? { data: row.data, mediaType: row.media_type } : null;
  }

  ensureProject(id: string, name: string): void {
    this.db.prepare("INSERT OR IGNORE INTO projects (id, name, created_at) VALUES (?, ?, ?)")
      .run(id, name, new Date().toISOString());
  }

  projects(): { id: string; name: string }[] {
    return this.db.prepare("SELECT id, name FROM projects ORDER BY created_at").all() as { id: string; name: string }[];
  }

  deleteProject(id: string): void {
    this.tx(() => {
      this.db.prepare("DELETE FROM events WHERE project_id = ?").run(id);
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(id);
    });
  }
}
