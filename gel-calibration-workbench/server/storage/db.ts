import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, renameSync } from 'node:fs';
import { dirname } from 'node:path';

export function openDatabase(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA foreign_keys = ON;');
  db.exec('PRAGMA synchronous = FULL;');
  migrate(db);
  return db;
}

function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    title TEXT NOT NULL,
    narrative TEXT NOT NULL,
    created_at TEXT NOT NULL,
    archived_at TEXT
  );
  CREATE TABLE IF NOT EXISTS blobs (
    key TEXT PRIMARY KEY,
    bytes BLOB NOT NULL,
    sha256 TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS params (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS derived (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    json TEXT NOT NULL,
    created_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    branch TEXT NOT NULL,
    parent_event_id TEXT,
    type TEXT NOT NULL,
    json TEXT NOT NULL,
    recorded_at TEXT NOT NULL,
    UNIQUE(case_id, branch, seq)
  );
  CREATE TABLE IF NOT EXISTS decisions (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    branch TEXT NOT NULL,
    event_seq INTEGER NOT NULL,
    json TEXT NOT NULL,
    recorded_at TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS write_ledger (
    tx_id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL,
    phase TEXT NOT NULL,
    payload TEXT NOT NULL,
    done INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_materials_case ON materials(case_id);
  CREATE INDEX IF NOT EXISTS idx_events_case ON events(case_id);
  CREATE INDEX IF NOT EXISTS idx_derived_case ON derived(case_id);
  `);
}

/**
 * 半写恢复：所有多表写入先登记 write_ledger（phase=prepared，fsync 后），
 * 提交后标记 done=1；打开时未 done 的事务回滚并返回恢复报告。
 */
export function recoverPendingWrites(db: DatabaseSync): {
  recovered: string[];
} {
  const pending = db
    .prepare('SELECT tx_id FROM write_ledger WHERE done = 0 ORDER BY created_at')
    .all() as Array<{ tx_id: string }>;
  const recovered: string[] = [];
  for (const row of pending) {
    db.prepare('DELETE FROM write_ledger WHERE tx_id = ?').run(row.tx_id);
    recovered.push(row.tx_id);
  }
  return { recovered };
}

export interface LedgerTx {
  txId: string;
  run: (sqls: Array<(tx: DatabaseSync) => void>) => void;
}

/**
 * 原子事务 + 两阶段账本。
 * 可通过 crashAfterPrepare 模拟“准备后崩溃”（半写），重启由 recoverPendingWrites 回滚。
 */
export function ledgerTransaction(
  db: DatabaseSync,
  txId: string,
  caseId: string,
  payload: string,
  body: (tx: DatabaseSync) => void,
  opts: { crashAfterPrepare?: boolean } = {},
): void {
  db.prepare(
    `INSERT OR REPLACE INTO write_ledger (tx_id, case_id, phase, payload, done, created_at)
     VALUES (?, ?, 'prepared', ?, 0, ?)`,
  ).run(txId, caseId, payload, new Date(0).toISOString());

  if (opts.crashAfterPrepare) {
    // 模拟进程在真正提交前崩溃：保留 prepared 记录与未落库痕迹
    throw new SimulatedCrash('SIMULATED_CRASH_AFTER_PREPARE');
  }

  const tx = db.exec.bind(db);
  db.exec('BEGIN IMMEDIATE');
  try {
    body(db);
    db.prepare('UPDATE write_ledger SET done = 1, phase = ? WHERE tx_id = ?').run(
      'committed',
      txId,
    );
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  void tx;
}

export class SimulatedCrash extends Error {}

export function checkpointWal(db: DatabaseSync): void {
  db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
}

export function replaceDatabaseAtomic(targetPath: string, buildTo: (path: string) => void): void {
  const tmp = targetPath + '.tmp';
  if (existsSync(tmp)) {
    for (const suffix of ['', '-wal', '-shm']) {
      try {
        renameSync(tmp + suffix, tmp + suffix);
      } catch {
        /* noop */
      }
    }
  }
  buildTo(tmp);
  renameSync(tmp, targetPath);
}
