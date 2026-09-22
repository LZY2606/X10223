import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite 存储层：事件追加日志 + 内容寻址 blob。
 * 派生状态不入库（fold 重放得到），保证历史不被新计算覆盖。
 */
export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec(`
    CREATE TABLE IF NOT EXISTS projects (
      project_id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      created_at_utc TEXT NOT NULL,
      case_pack_version TEXT
    );
    CREATE TABLE IF NOT EXISTS events (
      event_id TEXT NOT NULL,
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      seq INTEGER NOT NULL,
      branch TEXT NOT NULL,
      branch_seq INTEGER NOT NULL,
      prev_event_id TEXT,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      logical_clock INTEGER NOT NULL,
      wall_time_utc TEXT NOT NULL,
      digest TEXT NOT NULL,
      PRIMARY KEY (project_id, event_id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_branch
      ON events(project_id, branch, branch_seq);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_events_branch_seq
      ON events(project_id, branch, branch_seq);
    CREATE TABLE IF NOT EXISTS blobs (
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      uri TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      media_type TEXT NOT NULL,
      bytes BLOB NOT NULL,
      PRIMARY KEY (project_id, uri)
    );
    CREATE TABLE IF NOT EXISTS branches (
      project_id TEXT NOT NULL REFERENCES projects(project_id),
      name TEXT NOT NULL,
      parent_branch TEXT,
      parent_event_id TEXT,
      created_clock INTEGER NOT NULL,
      PRIMARY KEY (project_id, name)
    );
  `);
  return db;
}

export type DB = ReturnType<typeof openDatabase>;
