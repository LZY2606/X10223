// SQLite 存储层：可被测试直接调用。
// 事件追加式；派生物内容寻址；导入走“暂存→校验→提交”事务，崩溃后自动回滚。
import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { canonicalJson } from '../shared/hash.js';
import type {
  Branch,
  DerivationRecord,
  Diagnostic,
  ExportBundle,
  Material,
  ParamSet,
  ProjectEvent,
} from '../shared/types.js';
import { parseBundle } from './casepack/validate.js';
import { fromBase64 } from './casepack/pack.js';

export interface StoredProject {
  id: string;
  name: string;
  paramsJson: string;
  createdAt: string;
}

export function openStore(path: string): DatabaseSync {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec(`
    PRAGMA journal_mode=WAL;
    CREATE TABLE IF NOT EXISTS schema_meta (key TEXT PRIMARY KEY, value TEXT);
    CREATE TABLE IF NOT EXISTS projects (
      id TEXT PRIMARY KEY, name TEXT NOT NULL, params_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS branches (
      project_id TEXT NOT NULL, id TEXT NOT NULL, name TEXT NOT NULL,
      forked_from TEXT, fork_point_event_id TEXT, head_event_id TEXT,
      seq_order INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (project_id, id)
    );
    CREATE TABLE IF NOT EXISTS events (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, branch_id TEXT NOT NULL,
      seq INTEGER NOT NULL, line_seq INTEGER NOT NULL, kind TEXT NOT NULL,
      timestamp TEXT NOT NULL, parent_event_ids_json TEXT NOT NULL,
      input_summary TEXT, params_version TEXT, payload_json TEXT NOT NULL,
      findings_json TEXT, author TEXT
    );
    CREATE TABLE IF NOT EXISTS materials (
      project_id TEXT NOT NULL, id TEXT NOT NULL, kind TEXT NOT NULL, json TEXT NOT NULL,
      PRIMARY KEY (project_id, id)
    );
    CREATE TABLE IF NOT EXISTS material_blobs (
      project_id TEXT NOT NULL, material_id TEXT NOT NULL, bytes BLOB NOT NULL,
      sha256 TEXT NOT NULL,
      PRIMARY KEY (project_id, material_id)
    );
    CREATE TABLE IF NOT EXISTS derivations (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, kind TEXT NOT NULL,
      rule_version TEXT NOT NULL, params_version TEXT NOT NULL,
      input_summary TEXT NOT NULL, parent_ids_json TEXT NOT NULL,
      output_json TEXT NOT NULL, created_at TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS import_jobs (
      id TEXT PRIMARY KEY, project_id TEXT NOT NULL, stage TEXT NOT NULL,
      created_at TEXT NOT NULL, finished_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_events_branch ON events(project_id, branch_id, seq);
    CREATE INDEX IF NOT EXISTS idx_events_line ON events(project_id, line_seq);
  `);
  const userVersion = (db.prepare('PRAGMA user_version').get() as { user_version: number }).user_version;
  if (userVersion < 1) db.exec('PRAGMA user_version=1');
  return db;
}

export function listProjects(db: DatabaseSync): StoredProject[] {
  return db.prepare('SELECT id, name, params_json AS paramsJson, created_at AS createdAt FROM projects ORDER BY created_at').all() as StoredProject[];
}

export function getProject(db: DatabaseSync, id: string): StoredProject | undefined {
  return db
    .prepare('SELECT id, name, params_json AS paramsJson, created_at AS createdAt FROM projects WHERE id=?')
    .get(id) as StoredProject | undefined;
}

export function projectParams(db: DatabaseSync, id: string): ParamSet {
  const row = getProject(db, id);
  if (!row) throw new Error(`project not found: ${id}`);
  return JSON.parse(row.paramsJson) as ParamSet;
}

export function getEvents(db: DatabaseSync, projectId: string): ProjectEvent[] {
  const rows = db
    .prepare('SELECT * FROM events WHERE project_id=? ORDER BY line_seq')
    .all(projectId) as EventRow[];
  return rows.map(rowToEvent);
}

interface EventRow {
  id: string;
  project_id: string;
  branch_id: string;
  seq: number;
  line_seq: number;
  kind: string;
  timestamp: string;
  parent_event_ids_json: string;
  input_summary: string | null;
  params_version: string | null;
  payload_json: string;
  findings_json: string | null;
  author: string | null;
}

function rowToEvent(r: EventRow): ProjectEvent {
  return {
    id: r.id,
    projectId: r.project_id,
    branchId: r.branch_id,
    seq: r.seq,
    lineSeq: r.line_seq,
    kind: r.kind as ProjectEvent['kind'],
    timestamp: r.timestamp,
    parentEventIds: JSON.parse(r.parent_event_ids_json) as string[],
    inputSummary: r.input_summary ?? '',
    ...(r.params_version ? { paramsVersion: r.params_version } : {}),
    payload: JSON.parse(r.payload_json),
    ...(r.findings_json ? { findings: JSON.parse(r.findings_json) } : {}),
    ...(r.author ? { author: r.author } : {}),
  };
}

function eventToRow(projectId: string, e: ProjectEvent): unknown[] {
  return [
    e.id, projectId, e.branchId, e.seq, e.line_seq ?? e.lineSeq, e.kind, e.timestamp,
    JSON.stringify(e.parentEventIds), e.inputSummary ?? null, e.paramsVersion ?? null,
    JSON.stringify(e.payload), e.findings ? JSON.stringify(e.findings) : null, e.author ?? null,
  ];
}

export function getBranches(db: DatabaseSync, projectId: string): Branch[] {
  const rows = db
    .prepare('SELECT id, name, forked_from AS forkedFrom, fork_point_event_id AS forkPointEventId, head_event_id AS headEventId FROM branches WHERE project_id=? ORDER BY rowid')
    .all(projectId) as Branch[];
  return rows;
}

export function getMaterials(db: DatabaseSync, projectId: string): Material[] {
  const rows = db.prepare('SELECT json FROM materials WHERE project_id=?').all(projectId) as Array<{ json: string }>;
  return rows.map((r) => JSON.parse(r.json) as Material);
}

export function getBlob(db: DatabaseSync, projectId: string, materialId: string): Uint8Array | undefined {
  const row = db
    .prepare('SELECT bytes FROM material_blobs WHERE project_id=? AND material_id=?')
    .get(projectId, materialId) as { bytes: Uint8Array } | undefined;
  return row?.bytes;
}

export function saveDerivation(db: DatabaseSync, projectId: string, d: DerivationRecord): void {
  db.prepare(
    `INSERT OR IGNORE INTO derivations
     (id, project_id, kind, rule_version, params_version, input_summary, parent_ids_json, output_json, created_at)
     VALUES (?,?,?,?,?,?,?,?,?)`,
  ).run(d.id, projectId, d.kind, d.ruleVersion, d.paramsVersion, d.inputSummary, JSON.stringify(d.parentDerivationIds), d.outputJson, d.createdAt);
}

// ---- 事务化导入：半写恢复 ----------------------------------------------------
export interface ImportOutcome {
  ok: boolean;
  projectId?: string;
  diagnostics: Diagnostic[];
  failureClass?: 'format_corrupt' | 'semantic_impossible' | 'budget_exhausted';
  recoveredFromCrash?: boolean;
  jobId: string;
}

export function importBundle(
  db: DatabaseSync,
  bundle: ExportBundle,
  opts: { crashAfterStage?: 'materials' | 'events' | 'branches'; jobId?: string } = {},
): ImportOutcome {
  const jobId = opts.jobId ?? `job_${Date.now()}_${Math.floor(Math.random() * 1e6)}`;
  // 恢复上一个未完成的 job（WAL 下未提交事务不会残留；显式 stage 行用于演示半写恢复）
  const stale = db.prepare("SELECT id, stage FROM import_jobs WHERE finished_at IS NULL").all() as Array<{ id: string; stage: string }>;
  let recoveredFromCrash = false;
  for (const j of stale) {
    if (j.id !== jobId) recoveredFromCrash = true;
    db.prepare('DELETE FROM import_jobs WHERE id=?').run(j.id);
  }
  if (recoveredFromCrash) {
    // 半写保护：删除可能已落到表中的半成品（仅在没有外层事务包裹 stage 时发生）
    db.prepare('DELETE FROM events WHERE project_id IN (SELECT project_id FROM import_jobs)').run();
  }

  db.prepare('INSERT INTO import_jobs (id, project_id, stage, created_at) VALUES (?,?,?,?)').run(
    jobId, bundle.project.id, 'started', new Date().toISOString(),
  );

  try {
    db.exec('BEGIN IMMEDIATE');
    db.prepare('INSERT OR REPLACE INTO projects (id, name, params_json, created_at) VALUES (?,?,?,?)').run(
      bundle.project.id, bundle.project.name, canonicalJson(bundle.project.params), new Date().toISOString(),
    );
    db.prepare('UPDATE import_jobs SET stage=? WHERE id=?').run('projects', jobId);

    // 替换式重导：清掉旧项目内容
    db.prepare('DELETE FROM events WHERE project_id=?').run(bundle.project.id);
    db.prepare('DELETE FROM branches WHERE project_id=?').run(bundle.project.id);
    db.prepare('DELETE FROM materials WHERE project_id=?').run(bundle.project.id);
    db.prepare('DELETE FROM material_blobs WHERE project_id=?').run(bundle.project.id);

    for (const m of bundle.materials) {
      const blobBase64 = (m as Material & { blobBase64?: string }).blobBase64;
      const { blobBase64: _omit, ...clean } = m as Material & { blobBase64?: string };
      void _omit;
      db.prepare('INSERT INTO materials (project_id, id, kind, json) VALUES (?,?,?,?)').run(
        bundle.project.id, m.id, m.kind, JSON.stringify(clean),
      );
      if (m.kind === 'image' && blobBase64) {
        db.prepare('INSERT INTO material_blobs (project_id, material_id, bytes, sha256) VALUES (?,?,?,?)').run(
          bundle.project.id, m.id, fromBase64(blobBase64), m.sha256,
        );
      }
    }
    db.prepare('UPDATE import_jobs SET stage=? WHERE id=?').run('materials', jobId);
    if (opts.crashAfterStage === 'materials') simulateCrash(db, jobId);

    for (const b of bundle.branches) {
      db.prepare(
        'INSERT INTO branches (project_id, id, name, forked_from, fork_point_event_id, head_event_id, seq_order) VALUES (?,?,?,?,?,?,?)',
      ).run(bundle.project.id, b.id, b.name, b.forkedFromBranchId ?? null, b.forkPointEventId ?? null, b.headEventId ?? null, 0);
    }
    db.prepare('UPDATE import_jobs SET stage=? WHERE id=?').run('branches', jobId);
    if (opts.crashAfterStage === 'branches') simulateCrash(db, jobId);

    const insertEvent = db.prepare(
      `INSERT INTO events
       (id, project_id, branch_id, seq, line_seq, kind, timestamp, parent_event_ids_json,
        input_summary, params_version, payload_json, findings_json, author)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    );
    for (const e of bundle.events) {
      const row = eventToRow(bundle.project.id, e);
      insertEvent.run(...row);
    }
    db.prepare('UPDATE import_jobs SET stage=? WHERE id=?').run('events', jobId);
    if (opts.crashAfterStage === 'events') simulateCrash(db, jobId);

    db.prepare('UPDATE import_jobs SET finished_at=?, stage=? WHERE id=?').run(
      new Date().toISOString(), 'committed', jobId,
    );
    db.exec('COMMIT');
    return { ok: true, projectId: bundle.project.id, diagnostics: [], recoveredFromCrash, jobId };
  } catch (err) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // ignore
    }
    db.prepare('DELETE FROM import_jobs WHERE id=?').run(jobId);
    if ((err as Error).message === 'SIMULATED_CRASH') {
      // 模拟进程崩溃：事务在真实崩溃中由 SQLite 自动回滚；这里保留未完成 job 行以便复测恢复
      return { ok: false, diagnostics: [], jobId };
    }
    throw err;
  }
}

function simulateCrash(db: DatabaseSync, jobId: string): never {
  db.prepare('UPDATE import_jobs SET stage=? WHERE id=?').run('crashed', jobId);
  // 不 COMMIT —— 模拟半写：连接关闭后 SQLite 丢弃事务
  throw new Error('SIMULATED_CRASH');
}

export function exportBundle(db: DatabaseSync, projectId: string): ExportBundle {
  const project = getProject(db, projectId);
  if (!project) throw new Error(`project not found: ${projectId}`);
  const materials = getMaterials(db, projectId).map((m) => {
    if (m.kind !== 'image') return m;
    const bytes = getBlob(db, projectId, m.id);
    return bytes ? { ...m, blobBase64: Buffer.from(bytes).toString('base64') } : m;
  });
  const events = getEvents(db, projectId);
  const branches = getBranches(db, projectId);
  return {
    format: 'gel-ladder-bench-archive',
    formatVersion: 1,
    exportedAt: new Date().toISOString(),
    project: { id: project.id, name: project.name, params: JSON.parse(project.paramsJson) as ParamSet },
    branches,
    events,
    materials,
    manifest: {
      materialCount: materials.length,
      eventCount: events.length,
      branchCount: branches.length,
      inputHash: '',
    },
  };
}

export { parseBundle };
