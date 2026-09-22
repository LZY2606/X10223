import { DatabaseSync } from 'node:sqlite';

export type DB = DatabaseSync;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS materials(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS blobs(material_id TEXT PRIMARY KEY, data BLOB NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL UNIQUE, kind TEXT NOT NULL, json TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS derived(
  id TEXT PRIMARY KEY, subject_id TEXT NOT NULL, kind TEXT NOT NULL,
  version INTEGER NOT NULL, seq INTEGER NOT NULL,
  invalidated_seq INTEGER, invalidated_by TEXT, json TEXT NOT NULL);
CREATE INDEX IF NOT EXISTS idx_derived_subject ON derived(subject_id, version);
`;

/**
 * 打开数据库并做半写恢复：
 * 事件与派生行必须和 meta.committed_seq 在同一事务里提交；
 * 打开时把 seq 大于已提交序号的孤儿行清除，保证崩溃后回到一致状态。
 */
export function openDatabase(path: string): DB {
  const db = new DatabaseSync(path);
  db.exec(SCHEMA);
  const committed = committedSeq(db);
  db.exec('BEGIN');
  try {
    db.prepare('DELETE FROM events WHERE seq > ?').run(committed);
    db.prepare('DELETE FROM derived WHERE seq > ?').run(committed);
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
  return db;
}

export function committedSeq(db: DB): number {
  const row = db.prepare("SELECT value FROM meta WHERE key='committed_seq'").get() as { value: string } | undefined;
  return row ? Number(row.value) : 0;
}

/** 在一个事务里推进 committed_seq；fn 抛出则整体回滚（模拟/防御半写）。 */
export function commitSeq(db: DB, seq: number, fn: () => void): void {
  db.exec('BEGIN');
  try {
    fn();
    db.prepare('INSERT INTO meta(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value')
      .run('committed_seq', String(seq));
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  }
}
