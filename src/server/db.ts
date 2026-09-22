import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

export function openDb(path: string): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS projects (id TEXT PRIMARY KEY, name TEXT, created_at TEXT);
    CREATE TABLE IF NOT EXISTS images (
      id TEXT PRIMARY KEY, project_id TEXT, sha256 TEXT, width INTEGER, height INTEGER,
      format TEXT, bytes BLOB, meta TEXT
    );
    CREATE TABLE IF NOT EXISTS branches (
      project_id TEXT, name TEXT, parent TEXT, fork_seq INTEGER, created_at TEXT,
      PRIMARY KEY (project_id, name)
    );
    CREATE TABLE IF NOT EXISTS entities (
      project_id TEXT, id TEXT, version INTEGER, seq INTEGER, branch TEXT, kind TEXT, json TEXT,
      PRIMARY KEY (id, version)
    );
    CREATE TABLE IF NOT EXISTS events (
      project_id TEXT, id TEXT, seq INTEGER, branch TEXT, type TEXT, payload TEXT,
      parents TEXT, input_digest TEXT, params_version TEXT, created_at TEXT,
      PRIMARY KEY (id)
    );
    CREATE TABLE IF NOT EXISTS results (
      project_id TEXT, id TEXT, kind TEXT, subject_id TEXT, seq INTEGER, branch TEXT,
      payload TEXT, input_digest TEXT, params_version TEXT, parents TEXT,
      PRIMARY KEY (id)
    );
    CREATE INDEX IF NOT EXISTS idx_entities_proj ON entities(project_id, id, seq);
    CREATE INDEX IF NOT EXISTS idx_events_proj ON events(project_id, seq);
    CREATE INDEX IF NOT EXISTS idx_results_proj ON results(project_id, subject_id, seq);
  `);
  return db;
}

export function nextSeq(db: DB, projectId: string): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`seq:${projectId}`) as { value: string } | undefined;
  const seq = row ? parseInt(row.value, 10) + 1 : 1;
  db.prepare('INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(`seq:${projectId}`, String(seq));
  return seq;
}

export function currentSeq(db: DB, projectId: string): number {
  const row = db.prepare('SELECT value FROM meta WHERE key = ?').get(`seq:${projectId}`) as { value: string } | undefined;
  return row ? parseInt(row.value, 10) : 0;
}
