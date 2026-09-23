// SQLite schema + connection. Journal mode guarantees crash recovery; the
// staging tables make project import a two-phase commit so a torn write never
// corrupts existing data.
import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = Database.Database;

export const SCHEMA = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS projects (
  project_id    TEXT PRIMARY KEY,
  name          TEXT NOT NULL,
  created_at    TEXT NOT NULL,
  case_kind     TEXT NOT NULL DEFAULT ''
);

-- append-only events across all branches; (branch, seq) is the stable order
CREATE TABLE IF NOT EXISTS events (
  project_id    TEXT NOT NULL REFERENCES projects(project_id),
  branch        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  event_id      TEXT NOT NULL,
  type          TEXT NOT NULL,
  parents_json  TEXT NOT NULL,
  payload_json  TEXT NOT NULL,
  hash          TEXT NOT NULL,
  PRIMARY KEY (project_id, branch, seq),
  UNIQUE (project_id, event_id)
);

-- branch lineage: fork edge and the event it forked from
CREATE TABLE IF NOT EXISTS branches (
  project_id    TEXT NOT NULL REFERENCES projects(project_id),
  branch        TEXT NOT NULL,
  parent_branch TEXT,
  fork_event    TEXT,
  PRIMARY KEY (project_id, branch)
);

-- two-phase import staging; committed flag flips only after all rows land
CREATE TABLE IF NOT EXISTS import_staging (
  import_id     TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  committed     INTEGER NOT NULL DEFAULT 0,
  created_at    TEXT NOT NULL,
  PRIMARY KEY (import_id, project_id)
);

-- phase-1 landing area for imported events (raw, not yet promoted)
CREATE TABLE IF NOT EXISTS import_events_staging (
  import_id     TEXT NOT NULL,
  project_id    TEXT NOT NULL,
  branch        TEXT NOT NULL,
  seq           INTEGER NOT NULL,
  event_json    TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, branch, seq);
`;

export function openDB(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new Database(path);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  recoverStaging(db);
  return db;
}

/** Crash recovery: any staging import left uncommitted after a torn write is
 *  rolled back; committed ones have already promoted their rows. */
export function recoverStaging(db: DB): string[] {
  const pending = db.prepare(
    `SELECT import_id, project_id FROM import_staging WHERE committed = 0`,
  ).all() as Array<{ import_id: string; project_id: string }>;
  const rollback = db.transaction((importId: string, pid: string) => {
    db.prepare(`DELETE FROM import_events_staging WHERE import_id=? AND project_id=?`).run(importId, pid);
    // project row was created in phase 2 (promotion); an uncommitted import may
    // still have inserted it — remove only if it has no promoted events.
    const promoted = db.prepare(`SELECT COUNT(*) c FROM events WHERE project_id=?`).get(pid) as { c: number };
    if (promoted.c === 0) {
      db.prepare(`DELETE FROM branches WHERE project_id=?`).run(pid);
      db.prepare(`DELETE FROM projects WHERE project_id=?`).run(pid);
    }
    db.prepare(`DELETE FROM import_staging WHERE import_id = ? AND project_id = ?`)
      .run(importId, pid);
  });
  for (const row of pending) rollback(row.import_id, row.project_id);
  return pending.map((p) => p.import_id);
}
