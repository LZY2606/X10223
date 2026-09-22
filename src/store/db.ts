import { DatabaseSync } from 'node:sqlite';

export const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects(
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS branches(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS materials(
  id TEXT PRIMARY KEY,          -- 版本行 id
  identity TEXT NOT NULL,       -- 稳定身份（跨版本、跨导出导入）
  version INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  type TEXT NOT NULL,           -- image|ladder_nominal|lane_boundary|lane_curve|band_center
  json TEXT NOT NULL,           -- 原始表示（像素级来源、单位、坐标基准）
  digest TEXT NOT NULL,
  supersedes TEXT,
  created_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_identity ON materials(identity, version);
CREATE TABLE IF NOT EXISTS decisions(
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  type TEXT NOT NULL,           -- accept_candidate|reject_candidate|adjust_param|revise_source
  target_identity TEXT NOT NULL,
  json TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS computations(
  id TEXT PRIMARY KEY,
  identity TEXT NOT NULL,       -- 结果身份（同一逻辑结果跨版本）
  version INTEGER NOT NULL,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL,           -- local_scale|band_assessment
  input_digest TEXT NOT NULL,
  param_version TEXT NOT NULL,
  parent_ids TEXT NOT NULL,     -- JSON: 父级依赖 [{identity, version}]
  output TEXT NOT NULL,
  created_seq INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_computations_identity ON computations(identity, version);
CREATE TABLE IF NOT EXISTS events(
  seq INTEGER PRIMARY KEY,      -- 显式 seq：等价输入得到稳定顺序，导出导入保持
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  branch_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  parents TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export function openDb(path: string): DatabaseSync {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec(SCHEMA);
  return db;
}
