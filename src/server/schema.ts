export const SCHEMA_VERSION = 'gelwb-schema-1';

export const SCHEMA_SQL = `
PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  bytes BLOB NOT NULL,
  sha256 TEXT NOT NULL,
  byte_length INTEGER NOT NULL,
  commit_id TEXT
);

CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  json TEXT NOT NULL,
  commit_id TEXT
);

CREATE TABLE IF NOT EXISTS branches (
  id TEXT PRIMARY KEY,
  json TEXT NOT NULL,
  commit_id TEXT
);

CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  branch_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  parent_event_id TEXT,
  fork_from_event_id TEXT,
  type TEXT NOT NULL,
  at TEXT NOT NULL,
  actor TEXT NOT NULL,
  payload TEXT NOT NULL,
  produces TEXT NOT NULL,
  invalidates TEXT NOT NULL,
  commit_id TEXT
);
CREATE INDEX IF NOT EXISTS idx_events_branch ON events(branch_id, seq);

CREATE TABLE IF NOT EXISTS results (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  json TEXT NOT NULL,
  commit_id TEXT
);

CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  event_id TEXT NOT NULL,
  subject_result_id TEXT NOT NULL,
  verdict TEXT NOT NULL,
  note TEXT,
  commit_id TEXT
);

/**
 * 两阶段提交日志：
 *  PREPARED 后若进程崩溃（无 COMMITTED 标记），下次打开时回滚该 commit_id 的行，
 *  以保证“半写”可恢复而不是留下半截数据。
 */
CREATE TABLE IF NOT EXISTS commit_log (
  commit_id TEXT PRIMARY KEY,
  state TEXT NOT NULL CHECK (state IN ('PREPARED','COMMITTED')),
  started_at TEXT NOT NULL,
  finished_at TEXT
);
`;
