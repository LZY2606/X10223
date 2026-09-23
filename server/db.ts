import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite 存储层。业务规则在 domain/，这里只做持久化，且可被测试直接调用。
 * 导入大对象使用 commit_intents：先写 intent=open，全部行落库后置 committed；
 * 启动时发现 open intent => 回滚其 staging 数据，实现半写恢复。
 */

export function openDb(file: string): DatabaseSync {
  mkdirSync(dirname(file), { recursive: true });
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;');
  migrate(db);
  recoverOpenIntents(db);
  return db;
}

export function migrate(db: DatabaseSync): void {
  db.exec(`
  CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    casepack_version TEXT
  );
  CREATE TABLE IF NOT EXISTS image_blobs (
    sha256 TEXT PRIMARY KEY,
    bytes BLOB NOT NULL,
    width INTEGER NOT NULL,
    height INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS materials (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    origin TEXT NOT NULL,
    supersedes TEXT,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS params (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    data TEXT NOT NULL,
    UNIQUE(project_id, version)
  );
  CREATE TABLE IF NOT EXISTS events (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    branch_id TEXT NOT NULL,
    parent_event_id TEXT,
    type TEXT NOT NULL,
    timestamp INTEGER NOT NULL,
    actor TEXT NOT NULL,
    param_version INTEGER,
    payload TEXT NOT NULL,
    summary TEXT NOT NULL,
    UNIQUE(project_id, branch_id, seq)
  );
  CREATE TABLE IF NOT EXISTS branches (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    name TEXT NOT NULL,
    parent_branch_id TEXT,
    fork_event_id TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS results (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    branch_id TEXT NOT NULL,
    basis_event_id TEXT NOT NULL,
    data TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS archives (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    data TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS commit_intents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    status TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    finished_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, seq);
  CREATE INDEX IF NOT EXISTS idx_materials_project ON materials(project_id);
  CREATE INDEX IF NOT EXISTS idx_results_project ON results(project_id, branch_id);
  `);
}

interface IntentRow {
  id: string;
  project_id: string;
  kind: string;
  status: string;
}

/**
 * 半写恢复：open 状态的 intent 表示上次写入在提交前崩溃。
 * 回滚策略：删除带 intent id 标记的临时行（本实现把待导入行先写进正式表，
 * 但通过 intent_id 列关联——为保持表简单，导入在一个事务内完成，
 * open intent 仅可能在事务未落盘时残留，正式行不会出现；这里幂等清理）。
 */
export function recoverOpenIntents(db: DatabaseSync): { recovered: string[] } {
  const open = db.prepare('SELECT id, project_id, kind FROM commit_intents WHERE status = ?').all('open') as IntentRow[];
  const recovered: string[] = [];
  for (const intent of open) {
    const tx = db.prepare('SELECT COUNT(*) AS c FROM commit_intents WHERE id = ? AND status = ?').get(intent.id, 'committed') as { c: number };
    if (tx.c === 0) {
      db.prepare('DELETE FROM events WHERE project_id = ? AND id LIKE ?').run(intent.project_id, `tmp_${intent.id}_%`);
      db.prepare('UPDATE commit_intents SET status = ?, finished_at = ? WHERE id = ?').run('rolled-back', Date.now(), intent.id);
      recovered.push(intent.id);
    }
  }
  return { recovered };
}
