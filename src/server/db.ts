import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import type { BandResult, Diagnostic, Event, ExportBundle, Material } from '../shared/types.js';
import { canonicalize, digestOf } from '../shared/canon.js';

export interface ImportOptions {
  limits?: { maxMaterials: number; maxEvents: number; maxImageBytes: number };
  crashAfterPhase1?: boolean;
}
export type ImportOutcome =
  | { ok: true; importId: string; counts: { materials: number; events: number; results: number } }
  | { ok: false; failure: import('../shared/types.js').ImportFailure };

const DEFAULT_LIMITS = { maxMaterials: 100000, maxEvents: 100000, maxImageBytes: 50 * 1024 * 1024 };

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS images (
  id TEXT PRIMARY KEY, png BLOB NOT NULL, working_png BLOB NOT NULL,
  sha256 TEXT NOT NULL, created_seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, slot TEXT NOT NULL,
  branch TEXT NOT NULL, json TEXT NOT NULL, origin_event TEXT NOT NULL, seq INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, branch TEXT NOT NULL, type TEXT NOT NULL,
  parents TEXT NOT NULL, params_version TEXT NOT NULL, input_digest TEXT NOT NULL,
  created_at TEXT NOT NULL, payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS results (
  result_id TEXT NOT NULL, result_key TEXT NOT NULL, branch TEXT NOT NULL,
  event_id TEXT NOT NULL, seq INTEGER NOT NULL, json TEXT NOT NULL,
  PRIMARY KEY (event_id, result_id)
);
CREATE TABLE IF NOT EXISTS imports (
  id TEXT PRIMARY KEY, status TEXT NOT NULL, started_at TEXT NOT NULL, finished_at TEXT,
  bundle_digest TEXT, counts TEXT, note TEXT
);
`;

export function openDb(filename: string): DatabaseSync {
  if (filename !== ':memory:') mkdirSync(dirname(filename), { recursive: true });
  const db = new DatabaseSync(filename);
  db.exec(SCHEMA);
  recoverPendingImports(db);
  return db;
}

export function slotOf(m: Material): string {
  if (m.kind === 'band-centers') return `bands:${m.laneId}`;
  return m.kind;
}

export function putImage(
  db: DatabaseSync,
  id: string,
  png: Buffer,
  workingPng: Buffer,
  sha256: string,
  seq: number
): void {
  db.prepare('INSERT OR REPLACE INTO images (id, png, working_png, sha256, created_seq) VALUES (?,?,?,?,?)')
    .run(id, png, workingPng, sha256, seq);
}

export function putMaterial(db: DatabaseSync, m: Material, branch: string, eventId: string, seq: number): void {
  db.prepare(
    `INSERT INTO materials (id, kind, slot, branch, json, origin_event, seq)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET json=excluded.json`
  ).run(m.id, m.kind, slotOf(m), branch, canonicalize(m), eventId, seq);
}

export function nextSeq(db: DatabaseSync): number {
  const row = db.prepare('SELECT COALESCE(MAX(seq),0) AS s FROM events').get() as { s: number };
  return row.s + 1;
}

export function eventDigest(e: Pick<Event, 'seq' | 'branch' | 'type' | 'parents' | 'paramsVersion' | 'payload' | 'createdAt'>): string {
  return digestOf({
    seq: e.seq,
    branch: e.branch,
    type: e.type,
    parents: e.parents,
    paramsVersion: e.paramsVersion,
    payload: e.payload,
    createdAt: e.createdAt
  });
}

export function appendEvent(
  db: DatabaseSync,
  e: Omit<Event, 'seq' | 'inputDigest' | 'id'> & { seq?: number; id?: string }
): Event {
  const seq = e.seq ?? nextSeq(db);
  const id = e.id ?? `evt-${String(seq).padStart(4, '0')}`;
  const full: Event = {
    id,
    seq,
    type: e.type,
    branch: e.branch,
    parents: e.parents,
    paramsVersion: e.paramsVersion,
    inputDigest: '',
    createdAt: e.createdAt,
    payload: e.payload
  };
  full.inputDigest = eventDigest(full);
  db.prepare(
    `INSERT INTO events (id, seq, branch, type, parents, params_version, input_digest, created_at, payload)
     VALUES (?,?,?,?,?,?,?,?,?)`
  ).run(
    full.id,
    full.seq,
    full.branch,
    full.type,
    canonicalize(full.parents),
    full.paramsVersion,
    full.inputDigest,
    full.createdAt,
    canonicalize(full.payload)
  );
  return full;
}

export function recordResults(db: DatabaseSync, ev: Event, results: BandResult[]): void {
  const stmt = db.prepare(
    `INSERT OR REPLACE INTO results (result_id, result_key, branch, event_id, seq, json)
     VALUES (?,?,?,?,?,?)`
  );
  for (const r of results) {
    stmt.run(r.resultId, `${r.branch}:${r.laneId}:${r.bandIndex}`, r.branch, ev.id, ev.seq, canonicalize(r));
  }
}

export function listEvents(db: DatabaseSync): Event[] {
  const rows = db.prepare('SELECT * FROM events ORDER BY seq, id').all() as Record<string, unknown>[];
  return rows.map(rowToEvent);
}

export function rowToEvent(r: Record<string, unknown>): Event {
  return {
    id: r.id as string,
    seq: r.seq as number,
    branch: r.branch as string,
    type: r.type as Event['type'],
    parents: JSON.parse(r.parents as string),
    paramsVersion: r.params_version as string,
    inputDigest: r.input_digest as string,
    createdAt: r.created_at as string,
    payload: JSON.parse(r.payload as string)
  };
}

export function loadMaterialsForBranch(db: DatabaseSync, branch: string, atSeq: number): Material[] {
  // main 基线材料对所有分支可见；分支材料只在本分支可见；按 slot 取最新
  const rows = db
    .prepare(
      `SELECT json, slot, seq, branch FROM materials
       WHERE seq <= ? AND (branch = 'main' OR branch = ?)
       ORDER BY seq`
    )
    .all(atSeq, branch) as { json: string; slot: string }[];
  const bySlot = new Map<string, Material>();
  for (const r of rows) bySlot.set(r.slot, JSON.parse(r.json) as Material);
  return [...bySlot.values()];
}

export function resultsAt(db: DatabaseSync, branch: string, atSeq?: number): BandResult[] {
  const at = atSeq ?? Number.MAX_SAFE_INTEGER;
  const rows = db
    .prepare(
      `SELECT json FROM results
       WHERE branch = ? AND seq <= ?
       ORDER BY seq`
    )
    .all(branch, at) as { json: string }[];
  const byKey = new Map<string, BandResult>();
  for (const r of rows) {
    const res = JSON.parse(r.json) as BandResult;
    byKey.set(`${res.branch}:${res.laneId}:${res.bandIndex}`, res);
  }
  return [...byKey.values()].sort((a, b) => a.laneId.localeCompare(b.laneId) || a.bandIndex - b.bandIndex);
}

export function listBranches(db: DatabaseSync): string[] {
  const rows = db.prepare('SELECT DISTINCT branch FROM events ORDER BY branch').all() as { branch: string }[];
  return rows.map((r) => r.branch);
}

export function getImage(db: DatabaseSync, id: string): { png: Buffer; workingPng: Buffer } | null {
  const row = db.prepare('SELECT png, working_png FROM images WHERE id = ?').get(id) as
    | { png: Buffer; working_png: Buffer }
    | undefined;
  if (!row) return null;
  return { png: Buffer.from(row.png), workingPng: Buffer.from(row.working_png) };
}

// —— 导出：完整档案（材料 + 事件 + 派生结果），图像单独走 images ——
export function exportBundle(db: DatabaseSync, caseId: string, images: Record<string, string>): ExportBundle {
  const matRows = db.prepare('SELECT DISTINCT json FROM materials').all() as { json: string }[];
  const materials = matRows.map((r) => JSON.parse(r.json) as Material);
  const events = listEvents(db);
  const resRows = db
    .prepare(
      `SELECT json FROM results r1 WHERE seq = (SELECT MAX(seq) FROM results r2 WHERE r2.result_key = r1.result_key) ORDER BY branch, seq`
    )
    .all() as { json: string }[];
  const results = resRows.map((r) => JSON.parse(r.json) as BandResult);
  const maxSeq = events.reduce((m, e) => Math.max(m, e.seq), 0);
  const bundle: ExportBundle = {
    formatVersion: 1,
    caseId,
    exportedAt: new Date(0).toISOString(), // 导出时间由调用方决定；保持确定性
    materials,
    events,
    results,
    eventSeq: maxSeq
  };
  (bundle as ExportBundle & { images?: Record<string, string> }).images = images;
  return bundle;
}

// —— 半写恢复：上次未完成（phase1 已提交、phase2 未提交）的导入整体回滚 ——
export function recoverPendingImports(db: DatabaseSync): string[] {
  const pending = db.prepare("SELECT id FROM imports WHERE status = 'pending'").all() as { id: string }[];
  const recovered: string[] = [];
  for (const p of pending) {
    db.prepare("UPDATE imports SET status='rolled-back', note='recovered on open' WHERE id=?").run(p.id);
    recovered.push(p.id);
  }
  return recovered;
}

// 导入校验：格式损坏 / 语义无解 / 预算耗尽 —— 三种互斥结果
export function validateBundle(raw: unknown, limits = DEFAULT_LIMITS):
  | { ok: true; bundle: ExportBundle }
  | { ok: false; failure: import('../shared/types.js').ImportFailure } {
  let bundle: ExportBundle;
  try {
    bundle = raw as ExportBundle;
    if (bundle === null || typeof bundle !== 'object') throw new Error('root is not object');
    if (bundle.formatVersion !== 1) throw new Error(`unsupported formatVersion: ${String(bundle.formatVersion)}`);
    if (!Array.isArray(bundle.materials) || !Array.isArray(bundle.events) || !Array.isArray(bundle.results))
      throw new Error('missing materials/events/results arrays');
    for (const m of bundle.materials) {
      if (typeof m.id !== 'string' || typeof m.kind !== 'string')
        throw new Error(`material missing id/kind: ${JSON.stringify(m).slice(0, 80)}`);
    }
    for (const e of bundle.events) {
      if (typeof e.id !== 'string' || typeof e.seq !== 'number' || typeof e.type !== 'string')
        throw new Error(`event missing id/seq/type`);
      if (typeof e.payload !== 'object') throw new Error(`event ${e.id} payload not object`);
    }
  } catch (err) {
    return {
      ok: false,
      failure: { kind: 'format-corrupt', reason: (err as Error).message, location: 'bundle root / member' }
    };
  }

  // 预算
  const imgBytes = JSON.stringify((bundle as unknown as { images?: unknown }).images ?? {}).length;
  if (bundle.materials.length > limits.maxMaterials)
    return {
      ok: false,
      failure: { kind: 'budget-exhausted', reason: 'materials count over budget', used: bundle.materials.length, limit: limits.maxMaterials }
    };
  if (bundle.events.length > limits.maxEvents)
    return {
      ok: false,
      failure: { kind: 'budget-exhausted', reason: 'events count over budget', used: bundle.events.length, limit: limits.maxEvents }
    };
  if (imgBytes > limits.maxImageBytes)
    return {
      ok: false,
      failure: { kind: 'budget-exhausted', reason: 'image payload over budget', used: imgBytes, limit: limits.maxImageBytes }
    };

  // 语义：parent 缺失 / 摘要不一致 / seq 冲突
  const diagnostics: Diagnostic[] = [];
  const matIds = new Set(bundle.materials.map((m) => m.id));
  const eventIds = new Set<string>();
  let prevSeq = 0;
  for (const e of bundle.events) {
    if (eventIds.has(e.id))
      return {
        ok: false,
        failure: {
          kind: 'semantic-unsolvable',
          reason: `duplicate event id ${e.id}`,
          diagnostics
        }
      };
    if (e.seq !== prevSeq + 1)
      diagnostics.push({
        code: 'incomplete-input',
        location: { materialId: e.id },
        message: `event seq gap around ${e.seq}`
      });
    prevSeq = e.seq;
    eventIds.add(e.id);
  }
  for (const e of bundle.events) {
    for (const parent of e.parents) {
      if (matIds.has(parent) || eventIds.has(parent) || parent.startsWith('params-')) continue;
      diagnostics.push({
        code: 'incomplete-input',
        location: { materialId: e.id },
        message: `event ${e.id} references unknown parent ${parent}`
      });
    }
    const recomputed = eventDigest({
      seq: e.seq,
      branch: e.branch,
      type: e.type,
      parents: e.parents,
      paramsVersion: e.paramsVersion,
      payload: e.payload,
      createdAt: e.createdAt
    });
    if (recomputed !== e.inputDigest)
      diagnostics.push({
        code: 'digest-mismatch',
        location: { materialId: e.id },
        message: `event ${e.id} input digest mismatch`
      });
  }
  if (diagnostics.length > 0)
    return {
      ok: false,
      failure: { kind: 'semantic-unsolvable', reason: 'dependency chain not uniquely reconstructable', diagnostics }
    };
  return { ok: true, bundle };
}

const STG_DDL = `
CREATE TABLE IF NOT EXISTS stg_images (import_id TEXT, id TEXT, png BLOB, working_png BLOB, sha256 TEXT, seq INTEGER);
CREATE TABLE IF NOT EXISTS stg_materials (import_id TEXT, id TEXT, kind TEXT, slot TEXT, branch TEXT, json TEXT, origin_event TEXT, seq INTEGER);
CREATE TABLE IF NOT EXISTS stg_events (import_id TEXT, id TEXT, seq INTEGER, branch TEXT, type TEXT, parents TEXT, params_version TEXT, input_digest TEXT, created_at TEXT, payload TEXT);
CREATE TABLE IF NOT EXISTS stg_results (import_id TEXT, result_id TEXT, result_key TEXT, branch TEXT, event_id TEXT, seq INTEGER, json TEXT);
`;

export function importPhase1(
  db: DatabaseSync,
  bundle: ExportBundle,
  images: { id: string; png: Buffer; workingPng: Buffer }[],
  importId: string
): void {
  db.exec(STG_DDL);
  const now = `2026-09-25T00:00:00.${String(importId.length).padStart(3, '0')}Z`;
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare("INSERT INTO imports (id, status, started_at, bundle_digest) VALUES (?,?,?,?)").run(
      importId,
      'pending',
      now,
      digestOf({ events: bundle.events.map((e) => e.id), materials: bundle.materials.map((m) => m.id) })
    );
    const img = db.prepare('INSERT INTO stg_images VALUES (?,?,?,?,?,?)');
    for (const im of images) {
      const mat = bundle.materials.find((m) => m.id === im.id && m.kind === 'image') as
        | import('../shared/types.js').GelImageMaterial
        | undefined;
      img.run(importId, im.id, im.png, im.workingPng, mat?.sha256 ?? '', mat ? seqOfImage(bundle, im.id) : 0);
    }
    const mat = db.prepare('INSERT INTO stg_materials VALUES (?,?,?,?,?,?,?,?)');
    for (const m of bundle.materials) {
      const origin = bundle.events.find((e) => e.payload.materialId === m.id)?.id ?? bundle.events[0]?.id ?? '';
      const seq = bundle.events.find((e) => e.payload.materialId === m.id)?.seq ?? 1;
      mat.run(importId, m.id, m.kind, slotOf(m), branchOfMaterial(bundle, m.id), canonicalize(m), origin, seq);
    }
    const ev = db.prepare('INSERT INTO stg_events VALUES (?,?,?,?,?,?,?,?,?,?)');
    for (const e of bundle.events) {
      ev.run(importId, e.id, e.seq, e.branch, e.type, canonicalize(e.parents), e.paramsVersion, e.inputDigest, e.createdAt, canonicalize(e.payload));
    }
    const res = db.prepare('INSERT INTO stg_results VALUES (?,?,?,?,?,?,?)');
    for (const r of bundle.results) {
      res.run(importId, r.resultId, `${r.branch}:${r.laneId}:${r.bandIndex}`, r.branch, r.eventId, eventSeqOf(bundle, r.eventId), canonicalize(r));
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

function seqOfImage(b: ExportBundle, id: string): number {
  return b.events.find((e) => e.payload.imageId === id)?.seq ?? 1;
}
function branchOfMaterial(b: ExportBundle, id: string): string {
  return b.events.find((e) => e.payload.materialId === id)?.branch ?? 'main';
}
function eventSeqOf(b: ExportBundle, id: string): number {
  return b.events.find((e) => e.id === id)?.seq ?? 0;
}

export function importPhase2(db: DatabaseSync, importId: string): {
  materials: number;
  events: number;
  results: number;
} {
  const existing = db.prepare('SELECT COUNT(*) AS c FROM events').get() as { c: number };
  if (existing.c > 0) throw new Error('target database is not empty');
  db.exec('BEGIN IMMEDIATE');
  try {
    db.prepare('INSERT OR REPLACE INTO images (id,png,working_png,sha256,created_seq) SELECT id,png,working_png,sha256,seq FROM stg_images WHERE import_id=?').run(importId);
    db.prepare('INSERT OR REPLACE INTO materials (id,kind,slot,branch,json,origin_event,seq) SELECT id,kind,slot,branch,json,origin_event,seq FROM stg_materials WHERE import_id=?').run(importId);
    db.prepare('INSERT INTO events (id,seq,branch,type,parents,params_version,input_digest,created_at,payload) SELECT id,seq,branch,type,parents,params_version,input_digest,created_at,payload FROM stg_events WHERE import_id=? ORDER BY seq').run(importId);
    db.prepare('INSERT OR REPLACE INTO results (result_id,result_key,branch,event_id,seq,json) SELECT result_id,result_key,branch,event_id,seq,json FROM stg_results WHERE import_id=?').run(importId);
    db.prepare("UPDATE imports SET status='done', finished_at=?, counts=? WHERE id=?").run(
      '2026-09-25T00:00:01.000Z',
      JSON.stringify({
        materials: (db.prepare('SELECT COUNT(*) c FROM stg_materials WHERE import_id=?').get(importId) as { c: number }).c,
        events: (db.prepare('SELECT COUNT(*) c FROM stg_events WHERE import_id=?').get(importId) as { c: number }).c,
        results: (db.prepare('SELECT COUNT(*) c FROM stg_results WHERE import_id=?').get(importId) as { c: number }).c
      }),
      importId
    );
    db.prepare('DELETE FROM stg_images WHERE import_id=?').run(importId);
    db.prepare('DELETE FROM stg_materials WHERE import_id=?').run(importId);
    db.prepare('DELETE FROM stg_events WHERE import_id=?').run(importId);
    db.prepare('DELETE FROM stg_results WHERE import_id=?').run(importId);
    const counts = JSON.parse(
      (db.prepare('SELECT counts FROM imports WHERE id=?').get(importId) as { counts: string }).counts
    ) as { materials: number; events: number; results: number };
    db.exec('COMMIT');
    return counts;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function importBundle(
  db: DatabaseSync,
  raw: unknown,
  images: { id: string; png: Buffer; workingPng: Buffer }[],
  opts: ImportOptions = {}
): ImportOutcome {
  const checked = validateBundle(raw, opts.limits ?? DEFAULT_LIMITS);
  if (!checked.ok) return { ok: false, failure: checked.failure };
  const importId = `imp-${digestOf(JSON.stringify(checked.bundle.events.map((e) => e.id))).slice(7, 19)}`;
  importPhase1(db, checked.bundle, images, importId);
  if (opts.crashAfterPhase1) {
    return {
      ok: false,
      failure: { kind: 'format-corrupt', reason: 'simulated crash after phase 1 (half-write)' }
    };
  }
  const counts = importPhase2(db, importId);
  return { ok: true, importId, counts };
}

export function resetAll(db: DatabaseSync): void {
  db.exec(`
    DELETE FROM results; DELETE FROM events; DELETE FROM materials; DELETE FROM images; DELETE FROM imports;
    DROP TABLE IF EXISTS stg_images; DROP TABLE IF EXISTS stg_materials;
    DROP TABLE IF EXISTS stg_events; DROP TABLE IF EXISTS stg_results;
  `);
}
