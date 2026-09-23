import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    CREATE TABLE IF NOT EXISTS projects(
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      parent_id TEXT,
      branch_reason TEXT,
      created_seq INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materials(
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      revision INTEGER NOT NULL,
      supersedes TEXT,
      kind TEXT NOT NULL,
      seq INTEGER NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY(project_id, id, revision)
    );
    CREATE TABLE IF NOT EXISTS events(
      project_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      json TEXT NOT NULL,
      parents TEXT NOT NULL,
      PRIMARY KEY(project_id, seq)
    );
    CREATE TABLE IF NOT EXISTS computations(
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      kind TEXT NOT NULL,
      seq INTEGER NOT NULL,
      valid_to INTEGER,
      json TEXT NOT NULL,
      PRIMARY KEY(project_id, id)
    );
    CREATE TABLE IF NOT EXISTS archive(
      project_id TEXT NOT NULL,
      id TEXT NOT NULL,
      json TEXT NOT NULL,
      PRIMARY KEY(project_id, id)
    );
  `);
  return db;
}
