import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

let enabled = false;
export function enableNodeSqlite() {
  if (enabled) return;
  try {
    // Node 24 已稳定；保留显式启用钩子便于测试环境控制
    const mod = require('node:sqlite') as { DatabaseSync?: unknown };
    if (mod.DatabaseSync) enabled = true;
  } catch {
    enabled = true;
  }
}

export function openDatabase(path: string): DatabaseSync {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec('PRAGMA foreign_keys=ON;');
  db.exec('PRAGMA busy_timeout=5000;');
  migrate(db);
  return db;
}

export function migrate(db: DatabaseSync) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL,
      head_event_id TEXT,
      created_logical INTEGER NOT NULL,
      spec_json TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS blobs (
      sha256 TEXT PRIMARY KEY,
      format TEXT NOT NULL,
      bytes BLOB NOT NULL,
      size INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      type TEXT NOT NULL,
      body_json TEXT NOT NULL,
      logical_id TEXT,
      superseded_by TEXT,
      superseded_event_id TEXT,
      created_event_id TEXT,
      branch TEXT NOT NULL DEFAULT 'main',
      logical_clock INTEGER NOT NULL,
      PRIMARY KEY (project_id, id)
    );
    CREATE TABLE IF NOT EXISTS branch_heads (
      project_id TEXT NOT NULL,
      branch TEXT NOT NULL,
      head_event_id TEXT,
      seq_last INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, branch)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      parent_id TEXT,
      branch TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      author TEXT NOT NULL,
      rationale_json TEXT NOT NULL,
      logical_clock INTEGER NOT NULL,
      PRIMARY KEY (project_id, id)
    );
    CREATE TABLE IF NOT EXISTS derived (
      id TEXT NOT NULL,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      branch TEXT NOT NULL,
      at_event_id TEXT NOT NULL,
      subject_id TEXT NOT NULL,
      state TEXT NOT NULL,
      record_json TEXT NOT NULL,
      invalidated_by_json TEXT,
      logical_clock INTEGER NOT NULL,
      PRIMARY KEY (project_id, id, at_event_id)
    );
    CREATE TABLE IF NOT EXISTS import_journal (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      started_logical INTEGER NOT NULL,
      temp_path TEXT,
      state TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_events_proj ON events(project_id, branch, seq);
    CREATE INDEX IF NOT EXISTS idx_materials_proj ON materials(project_id, branch);
    CREATE INDEX IF NOT EXISTS idx_derived_proj ON derived(project_id, at_event_id);
  `);
}

/** 半写恢复：启动时回收所有未完成的导入/导出事务痕迹 */
export function recoverPendingWrites(db: DatabaseSync): { recovered: number } {
  const pending = db.prepare(`SELECT id, project_id, kind, temp_path FROM import_journal WHERE state='started'`).all() as {
    id: number;
    project_id: string;
    kind: string;
    temp_path: string | null;
  }[];
  for (const row of pending) {
    db.prepare(`UPDATE import_journal SET state='rolled_back' WHERE id=?`).run(row.id);
  }
  return { recovered: pending.length };
}
