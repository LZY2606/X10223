import { createRequire } from "node:module";
import type { DatabaseSync as DatabaseSyncT } from "node:sqlite";
const require = createRequire(import.meta.url);
const { DatabaseSync } = require("node:sqlite") as { DatabaseSync: typeof DatabaseSyncT };
import type { Material, Derived, EventRecord, Branch } from "../src/domain/model.ts";
import type { Bundle } from "../src/domain/exportImport.ts";

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, version INTEGER NOT NULL,
  supersedes TEXT, payload TEXT NOT NULL, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS derived (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, param_version TEXT NOT NULL,
  input_digest TEXT NOT NULL, parents TEXT NOT NULL, status TEXT NOT NULL, payload TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, branch TEXT NOT NULL,
  kind TEXT NOT NULL, payload TEXT NOT NULL, parents TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY, name TEXT NOT NULL, parent TEXT, created_by TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS import_batches (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT);
CREATE TABLE IF NOT EXISTS batch_rows (
  batch_id TEXT NOT NULL, table_name TEXT NOT NULL, row_id TEXT NOT NULL,
  PRIMARY KEY (batch_id, table_name, row_id));
`;

export class Store {
  db: InstanceType<typeof DatabaseSyncT>;

  constructor(path: string) {
    this.db = new DatabaseSync(path) as InstanceType<typeof DatabaseSyncT>;
    this.db.exec(SCHEMA);
    this.recover();
  }

  /** Half-write recovery: any import batch left 'pending' (crash mid-write) is rolled back. */
  recover(): string[] {
    const pending = this.db.prepare("SELECT id FROM import_batches WHERE status='pending'").all() as { id: string }[];
    for (const b of pending) {
      const rows = this.db.prepare("SELECT table_name, row_id FROM batch_rows WHERE batch_id=?").all(b.id) as { table_name: string; row_id: string }[];
      for (const r of rows) {
        if (["materials", "derived", "events", "branches"].includes(r.table_name)) {
          this.db.prepare(`DELETE FROM ${r.table_name} WHERE id=?`).run(r.row_id);
        }
      }
      this.db.prepare("UPDATE import_batches SET status='rolled-back', finished_at=? WHERE id=?").run(new Date().toISOString(), b.id);
      this.db.prepare("DELETE FROM batch_rows WHERE batch_id=?").run(b.id);
    }
    return pending.map((p) => p.id);
  }

  getMeta(key: string): string | null {
    const r = this.db.prepare("SELECT value FROM meta WHERE key=?").get(key) as { value: string } | undefined;
    return r ? r.value : null;
  }
  setMeta(key: string, value: string): void {
    this.db.prepare("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, value);
  }

  insertMaterial(m: Material): void {
    this.db.prepare("INSERT OR IGNORE INTO materials (id, kind, version, supersedes, payload, created_by) VALUES (?,?,?,?,?,?)")
      .run(m.id, m.kind, m.version, m.supersedes, JSON.stringify(m.payload), m.createdByEvent);
  }
  insertDerived(d: Derived): void {
    this.db.prepare("INSERT OR REPLACE INTO derived (id, kind, param_version, input_digest, parents, status, payload) VALUES (?,?,?,?,?,?,?)")
      .run(d.id, d.kind, d.paramVersion, d.inputDigest, JSON.stringify(d.parents), d.status, JSON.stringify(d.payload));
  }
  insertEvent(e: EventRecord): void {
    this.db.prepare("INSERT OR IGNORE INTO events (id, seq, branch, kind, payload, parents) VALUES (?,?,?,?,?,?)")
      .run(e.id, e.seq, e.branchId, e.kind, JSON.stringify(e.payload), JSON.stringify(e.parents));
  }
  insertBranch(b: Branch): void {
    this.db.prepare("INSERT OR IGNORE INTO branches (id, name, parent, created_by) VALUES (?,?,?,?)")
      .run(b.id, b.name, b.parent, b.createdByEvent);
  }

  materials(): Material[] {
    return (this.db.prepare("SELECT * FROM materials").all() as any[]).map((r) => ({
      id: r.id, kind: r.kind, version: r.version, supersedes: r.supersedes, payload: JSON.parse(r.payload), createdByEvent: r.created_by,
    }));
  }
  derived(): Derived[] {
    return (this.db.prepare("SELECT * FROM derived").all() as any[]).map((r) => ({
      id: r.id, kind: r.kind, paramVersion: r.param_version,
      inputDigest: r.input_digest, parents: JSON.parse(r.parents), status: r.status, payload: JSON.parse(r.payload),
    })) as Derived[];
  }
  events(): EventRecord[] {
    return (this.db.prepare("SELECT * FROM events ORDER BY seq").all() as any[]).map((r) => ({
      id: r.id, seq: r.seq, branchId: r.branch, kind: r.kind, payload: JSON.parse(r.payload), parents: JSON.parse(r.parents),
    }));
  }
  branches(): Branch[] {
    return (this.db.prepare("SELECT * FROM branches").all() as any[]).map((r) => ({
      id: r.id, name: r.name, parent: r.parent, createdByEvent: r.created_by,
    }));
  }
  nextSeq(): number {
    const r = this.db.prepare("SELECT COALESCE(MAX(seq), -1) + 1 AS n FROM events").get() as { n: number };
    return r.n;
  }
  markDerivedSuperseded(ids: string[]): void {
    const stmt = this.db.prepare("UPDATE derived SET status='superseded' WHERE id=?");
    for (const id of ids) stmt.run(id);
  }

  clearAll(): void {
    this.db.exec("DELETE FROM materials; DELETE FROM derived; DELETE FROM events; DELETE FROM branches;");
  }

  /** Import a bundle inside a journaled batch so a crash mid-write is recoverable. */
  importBundle(bundle: Bundle, batchId: string): void {
    this.db.prepare("INSERT INTO import_batches (id, status, started_at) VALUES (?, 'pending', ?)").run(batchId, new Date().toISOString());
    const track = this.db.prepare("INSERT OR IGNORE INTO batch_rows (batch_id, table_name, row_id) VALUES (?,?,?)");
    try {
      this.db.exec("BEGIN");
      for (const b of bundle.branches) { this.insertBranch(b); track.run(batchId, "branches", b.id); }
      for (const m of bundle.materials) { this.insertMaterial(m); track.run(batchId, "materials", m.id); }
      for (const d of bundle.derived) { this.insertDerived(d); track.run(batchId, "derived", d.id); }
      for (const e of bundle.events) { this.insertEvent(e); track.run(batchId, "events", e.id); }
      this.db.exec("COMMIT");
      this.db.prepare("UPDATE import_batches SET status='committed', finished_at=? WHERE id=?").run(new Date().toISOString(), batchId);
      this.db.prepare("DELETE FROM batch_rows WHERE batch_id=?").run(batchId);
    } catch (e) {
      this.db.exec("ROLLBACK");
      this.db.prepare("UPDATE import_batches SET status='failed', finished_at=? WHERE id=?").run(new Date().toISOString(), batchId);
      throw e;
    }
  }

  close(): void {
    this.db.close();
  }
}
