import { DatabaseSync } from 'node:sqlite'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true })
  const db = new DatabaseSync(path)
  db.exec('PRAGMA journal_mode=WAL')
  db.exec('PRAGMA foreign_keys=ON')
  migrate(db)
  return db
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    project_id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at TEXT NOT NULL,
    head_branch TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS branches (
    branch_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    parent_branch TEXT,
    forked_from_event TEXT,
    label TEXT NOT NULL,
    created_at TEXT NOT NULL
  );

  CREATE TABLE IF NOT EXISTS events (
    event_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    branch_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    parent_id TEXT,
    at TEXT NOT NULL,
    type TEXT NOT NULL,
    payload TEXT NOT NULL,
    sha TEXT NOT NULL,
    PRIMARY KEY (project_id, event_id),
    UNIQUE (project_id, branch_id, seq)
  );

  CREATE TABLE IF NOT EXISTS artifacts (
    artifact_id TEXT NOT NULL,
    project_id TEXT NOT NULL REFERENCES projects(project_id),
    kind TEXT NOT NULL,
    produced_by_event TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    valid INTEGER NOT NULL DEFAULT 1,
    superseded_by TEXT,
    payload TEXT NOT NULL,
    sha TEXT NOT NULL,
    PRIMARY KEY (project_id, artifact_id)
  );

  CREATE TABLE IF NOT EXISTS blobs (
    blob_id TEXT PRIMARY KEY,
    content BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    byte_length INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_events_branch ON events(project_id, branch_id, seq);
  CREATE INDEX IF NOT EXISTS idx_art_branch ON artifacts(project_id, branch_id, valid);
  `)
  db.prepare("INSERT OR IGNORE INTO meta(key,value) VALUES ('schema_version','1')").run()
}

export type DB = ReturnType<typeof openDatabase>
