import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

/**
 * SQLite 存储：事件为源真相，快照为缓存。
 * 所有多表写入走 writeBatch：先写 journal(committed=0)，再写数据，最后标记 committed=1。
 * 打开库时 recover() 清除所有未提交批次 —— 半写状态不会以"成功"面貌出现。
 */
export class Store {
  readonly db: DatabaseSync;

  constructor(path: string) {
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT);
      CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY, name TEXT, created_seq INTEGER);
      CREATE TABLE IF NOT EXISTS branches(id TEXT PRIMARY KEY, project_id TEXT, name TEXT, head_event_id TEXT);
      CREATE TABLE IF NOT EXISTS events(
        id TEXT PRIMARY KEY, project_id TEXT, branch_id TEXT, seq INTEGER,
        parents TEXT, kind TEXT, actor TEXT, inputs_summary TEXT, params_version TEXT, payload TEXT,
        batch_id TEXT);
      CREATE TABLE IF NOT EXISTS materials(
        id TEXT PRIMARY KEY, project_id TEXT, kind TEXT, body TEXT,
        superseded_by TEXT, batch_id TEXT);
      CREATE TABLE IF NOT EXISTS decisions(
        id TEXT PRIMARY KEY, project_id TEXT, event_id TEXT, body TEXT, batch_id TEXT);
      CREATE TABLE IF NOT EXISTS snapshots(
        project_id TEXT, event_id TEXT, body TEXT, batch_id TEXT,
        PRIMARY KEY(project_id, event_id));
      CREATE TABLE IF NOT EXISTS journal(batch_id TEXT PRIMARY KEY, committed INTEGER);
    `);
    this.recover();
  }

  /** 清理未提交批次（半写恢复） */
  recover(): number {
    const torn = this.db.prepare('SELECT batch_id FROM journal WHERE committed = 0').all() as { batch_id: string }[];
    for (const { batch_id } of torn) {
      for (const table of ['events', 'materials', 'decisions', 'snapshots']) {
        this.db.prepare(`DELETE FROM ${table} WHERE batch_id = ?`).run(batch_id);
      }
      this.db.prepare('DELETE FROM journal WHERE batch_id = ?').run(batch_id);
    }
    return torn.length;
  }

  /** 事务性批量写入；任何一步失败整体回滚，绝不留下半成品 */
  writeBatch<T>(batchId: string, fn: () => T): T {
    this.db.exec('BEGIN');
    try {
      this.db.prepare('INSERT INTO journal(batch_id, committed) VALUES (?, 0)').run(batchId);
      const result = fn();
      this.db.prepare('UPDATE journal SET committed = 1 WHERE batch_id = ?').run(batchId);
      this.db.exec('COMMIT');
      return result;
    } catch (err) {
      this.db.exec('ROLLBACK');
      throw err;
    }
  }

  /** 仅用于测试：模拟崩溃留下的半写状态（数据已落盘但提交标记丢失） */
  simulateTornWrite(batchId: string, writes: () => void): void {
    this.db.exec('BEGIN');
    this.db.prepare('INSERT INTO journal(batch_id, committed) VALUES (?, 0)').run(batchId);
    writes();
    this.db.exec('COMMIT'); // 数据落盘，但 journal 永远停在 committed=0
  }

  getMeta(key: string): string | undefined {
    const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key) as { value: string } | undefined;
    return row?.value;
  }

  setMeta(key: string, value: string): void {
    this.db.prepare('INSERT INTO meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, value);
  }

  close(): void {
    this.db.close();
  }
}
