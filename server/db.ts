import { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = "1";

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;
    CREATE TABLE IF NOT EXISTS meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS branches (
      id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      name TEXT NOT NULL,
      parent_id TEXT
    );
    -- 不可变材料：内容寻址身份，原图/方向/曝光/标称值/边界/条带中心均带像素级来源
    CREATE TABLE IF NOT EXISTS materials (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      lane_index INTEGER,
      version INTEGER NOT NULL,
      payload TEXT NOT NULL,
      digest TEXT NOT NULL
    );
    -- 派生结果：身份 = f(输入摘要, 参数版本)，记录父级依赖
    CREATE TABLE IF NOT EXISTS derived (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      lane_index INTEGER,
      payload TEXT NOT NULL,
      digest TEXT NOT NULL,
      input_digest TEXT NOT NULL,
      param_version TEXT NOT NULL,
      parents TEXT NOT NULL
    );
    -- 可修改决定
    CREATE TABLE IF NOT EXISTS decisions (
      id TEXT PRIMARY KEY,
      subject_id TEXT NOT NULL,
      action TEXT NOT NULL,
      payload TEXT NOT NULL
    );
    -- 追加式事件日志（机器可读取）
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY,
      seq INTEGER NOT NULL,
      type TEXT NOT NULL,
      branch_id TEXT NOT NULL,
      payload TEXT NOT NULL,
      parents TEXT NOT NULL,
      input_digest TEXT,
      param_version TEXT,
      created_at TEXT NOT NULL
    );
    -- 分支成员关系：对象全局内容寻址，分支是视图
    CREATE TABLE IF NOT EXISTS refs (
      branch_id TEXT NOT NULL,
      kind TEXT NOT NULL,
      object_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (branch_id, kind, object_id)
    );
    -- 局部失效记录（分支局部）
    CREATE TABLE IF NOT EXISTS invalidations (
      branch_id TEXT NOT NULL,
      object_id TEXT NOT NULL,
      reason TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (branch_id, object_id)
    );
  `);
  const init = db.prepare(`INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)`);
  init.run("schema_version", SCHEMA_VERSION);
  init.run("seq", "0");
  return db;
}
