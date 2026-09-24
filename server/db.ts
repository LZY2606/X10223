import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { digestOf, shortId } from "./canon.ts";
import type { DerivedRow, EventRow, MaterialRow } from "./types.ts";

export interface Store {
  db: DatabaseSync;
  path: string;
}

export function openStore(path: string): Store {
  if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  initSchema(db);
  return { db, path };
}

function initSchema(db: DatabaseSync): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      payload TEXT NOT NULL,
      digest TEXT NOT NULL,
      created_seq INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_materials_project ON materials(project_id, created_seq);
    CREATE TABLE IF NOT EXISTS events (
      project_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      id TEXT NOT NULL UNIQUE,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      parents TEXT NOT NULL,
      created_at TEXT NOT NULL,
      PRIMARY KEY (project_id, seq)
    );
    CREATE TABLE IF NOT EXISTS blobs (
      id TEXT PRIMARY KEY,
      data BLOB NOT NULL
    );
    CREATE TABLE IF NOT EXISTS derived (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      slot TEXT NOT NULL,
      rule TEXT NOT NULL,
      rule_version TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      parents TEXT NOT NULL,
      status TEXT NOT NULL,
      payload TEXT NOT NULL,
      created_seq INTEGER NOT NULL,
      superseded_by TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_derived_slot ON derived(project_id, slot);
  `);
}

// ---------- projects ----------

export function createProject(store: Store, id: string, name: string): void {
  store.db
    .prepare("INSERT INTO projects (id, name, created_at) VALUES (?, ?, ?)")
    .run(id, name, new Date().toISOString());
}

export function listProjects(store: Store): Array<{ id: string; name: string }> {
  return store.db
    .prepare("SELECT id, name FROM projects ORDER BY id")
    .all() as Array<{ id: string; name: string }>;
}

export function getProject(store: Store, id: string): { id: string; name: string } | undefined {
  return store.db.prepare("SELECT id, name FROM projects WHERE id = ?").get(id) as
    | { id: string; name: string }
    | undefined;
}

export function deleteProject(store: Store, projectId: string): void {
  const tx = store.db;
  tx.exec("BEGIN");
  try {
    tx.prepare("DELETE FROM derived WHERE project_id = ?").run(projectId);
    tx.prepare("DELETE FROM events WHERE project_id = ?").run(projectId);
    tx.prepare("DELETE FROM materials WHERE project_id = ?").run(projectId);
    tx.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
    tx.exec("COMMIT");
  } catch (err) {
    tx.exec("ROLLBACK");
    throw err;
  }
}

// ---------- materials ----------

export function insertMaterial(
  store: Store,
  projectId: string,
  kind: string,
  payload: Record<string, unknown>,
  createdSeq: number,
  id?: string,
): MaterialRow {
  const digest = digestOf(payload);
  const materialId = id ?? shortId("mat", projectId, kind, digest);
  store.db
    .prepare(
      "INSERT INTO materials (id, project_id, kind, payload, digest, created_seq) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run(materialId, projectId, kind, JSON.stringify(payload), digest, createdSeq);
  return { id: materialId, projectId, kind, payload, digest, createdSeq };
}

export function listMaterials(store: Store, projectId: string, asOf?: number): MaterialRow[] {
  const rows = (
    asOf === undefined
      ? store.db
          .prepare(
            "SELECT id, project_id, kind, payload, digest, created_seq FROM materials WHERE project_id = ? ORDER BY created_seq, id",
          )
          .all(projectId)
      : store.db
          .prepare(
            "SELECT id, project_id, kind, payload, digest, created_seq FROM materials WHERE project_id = ? AND created_seq <= ? ORDER BY created_seq, id",
          )
          .all(projectId, asOf)
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    projectId: r.project_id as string,
    kind: r.kind as string,
    payload: JSON.parse(r.payload as string),
    digest: r.digest as string,
    createdSeq: r.created_seq as number,
  }));
}

// ---------- events ----------

export function maxSeq(store: Store, projectId: string): number {
  const row = store.db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS m FROM events WHERE project_id = ?")
    .get(projectId) as { m: number };
  return row.m;
}

export function appendEvent(
  store: Store,
  projectId: string,
  type: string,
  payload: Record<string, unknown>,
  parents: string[],
  seq?: number,
  id?: string,
  createdAt?: string,
): EventRow {
  const eventSeq = seq ?? maxSeq(store, projectId) + 1;
  const eventId = id ?? shortId("evt", projectId, eventSeq, type, payload);
  const at = createdAt ?? new Date().toISOString();
  store.db
    .prepare(
      "INSERT INTO events (project_id, seq, id, type, payload, parents, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
    )
    .run(projectId, eventSeq, eventId, type, JSON.stringify(payload), JSON.stringify(parents), at);
  return { projectId, seq: eventSeq, id: eventId, type, payload, parents, createdAt: at };
}

export function listEvents(store: Store, projectId: string, asOf?: number): EventRow[] {
  const rows = (
    asOf === undefined
      ? store.db
          .prepare(
            "SELECT project_id, seq, id, type, payload, parents, created_at FROM events WHERE project_id = ? ORDER BY seq",
          )
          .all(projectId)
      : store.db
          .prepare(
            "SELECT project_id, seq, id, type, payload, parents, created_at FROM events WHERE project_id = ? AND seq <= ? ORDER BY seq",
          )
          .all(projectId, asOf)
  ) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    projectId: r.project_id as string,
    seq: r.seq as number,
    id: r.id as string,
    type: r.type as string,
    payload: JSON.parse(r.payload as string),
    parents: JSON.parse(r.parents as string) as string[],
    createdAt: r.created_at as string,
  }));
}

// ---------- blobs ----------

export function putBlob(store: Store, id: string, data: Buffer): void {
  store.db.prepare("INSERT OR REPLACE INTO blobs (id, data) VALUES (?, ?)").run(id, data);
}

export function getBlob(store: Store, id: string): Buffer | undefined {
  const row = store.db.prepare("SELECT data FROM blobs WHERE id = ?").get(id) as
    | { data: Buffer }
    | undefined;
  return row?.data;
}

// ---------- derived cache (append-only history; supersession marked, never deleted) ----------

export function upsertDerived(store: Store, rows: DerivedRow[]): void {
  const insert = store.db.prepare(
    `INSERT INTO derived (id, project_id, slot, rule, rule_version, input_digest, parents, status, payload, created_seq, superseded_by)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)
     ON CONFLICT(id) DO NOTHING`,
  );
  const supersede = store.db.prepare(
    "UPDATE derived SET superseded_by = ? WHERE project_id = ? AND slot = ? AND id != ? AND superseded_by IS NULL",
  );
  for (const row of rows) {
    insert.run(
      row.id,
      row.projectId,
      row.slot,
      row.rule,
      row.ruleVersion,
      row.inputDigest,
      JSON.stringify(row.parents),
      row.status,
      JSON.stringify(row.payload),
      row.createdSeq,
    );
    supersede.run(row.id, row.projectId, row.slot, row.id);
  }
}

export function listDerived(store: Store, projectId: string): DerivedRow[] {
  const rows = store.db
    .prepare(
      "SELECT id, project_id, slot, rule, rule_version, input_digest, parents, status, payload, created_seq, superseded_by FROM derived WHERE project_id = ? ORDER BY created_seq, id",
    )
    .all(projectId) as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    id: r.id as string,
    projectId: r.project_id as string,
    slot: r.slot as string,
    rule: r.rule as string,
    ruleVersion: r.rule_version as string,
    inputDigest: r.input_digest as string,
    parents: JSON.parse(r.parents as string) as string[],
    status: r.status as string,
    payload: JSON.parse(r.payload as string),
    createdSeq: r.created_seq as number,
    supersededBy: (r.superseded_by as string | null) ?? null,
  }));
}
