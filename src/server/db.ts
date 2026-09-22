import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  committed INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  digest TEXT NOT NULL,
  content BLOB,
  meta TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES batches(id),
  seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  params_version TEXT NOT NULL,
  parents TEXT NOT NULL,
  batch_id TEXT NOT NULL REFERENCES batches(id)
);
CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL REFERENCES events(id),
  seq INTEGER NOT NULL,
  status TEXT NOT NULL,
  payload TEXT NOT NULL,
  valid INTEGER NOT NULL DEFAULT 1,
  invalidated_by TEXT
);
CREATE TABLE IF NOT EXISTS counters (
  key TEXT PRIMARY KEY,
  value INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_events_seq ON events(seq);
CREATE INDEX IF NOT EXISTS idx_results_event ON results(event_id);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  recover(db);
  return db;
}

/** 半写恢复：删除未提交批次写入的所有行（导入/计算中断不会留下半截状态） */
export function recover(db: DatabaseSync): { droppedBatches: string[] } {
  const uncommitted = db
    .prepare('SELECT id FROM batches WHERE committed = 0')
    .all() as { id: string }[];
  for (const b of uncommitted) {
    db.prepare('DELETE FROM results WHERE event_id IN (SELECT id FROM events WHERE batch_id = ?)').run(b.id);
    db.prepare('DELETE FROM events WHERE batch_id = ?').run(b.id);
    db.prepare('DELETE FROM materials WHERE batch_id = ?').run(b.id);
    db.prepare('DELETE FROM batches WHERE id = ?').run(b.id);
  }
  return { droppedBatches: uncommitted.map((b) => b.id) };
}

export function nextSeq(db: DatabaseSync, key: string): number {
  db.prepare('INSERT INTO counters(key, value) VALUES(?, 0) ON CONFLICT(key) DO NOTHING').run(key);
  db.prepare('UPDATE counters SET value = value + 1 WHERE key = ?').run(key);
  const row = db.prepare('SELECT value FROM counters WHERE key = ?').get(key) as { value: number };
  return row.value;
}
