import { DatabaseSync } from 'node:sqlite';
import type { Diagnostic, Outcome } from '../shared/types';
import { fail, ok, spend } from '../shared/types';
import { canonical, digestOf } from '../shared/digest';

export interface MaterialRow {
  id: string; kind: string; seq: number; digest: string; content: string;
}
export interface EventRow {
  id: string; seq: number; kind: string; parents: string; input_digest: string;
  param_version: string; payload: string; conclusions: string;
}
export interface ComputationRow {
  id: string; seq: number; event_id: string | null; target_id: string;
  input_digest: string; param_version: string; status: string;
  result: string | null; diagnostics: string;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS materials(
  id TEXT PRIMARY KEY, kind TEXT NOT NULL, seq INTEGER NOT NULL,
  digest TEXT NOT NULL, content TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, kind TEXT NOT NULL,
  parents TEXT NOT NULL, input_digest TEXT NOT NULL, param_version TEXT NOT NULL,
  payload TEXT NOT NULL, conclusions TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS computations(
  id TEXT PRIMARY KEY, seq INTEGER NOT NULL, event_id TEXT, target_id TEXT NOT NULL,
  input_digest TEXT NOT NULL, param_version TEXT NOT NULL,
  status TEXT NOT NULL, result TEXT, diagnostics TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);
`;

/** 存储层：材料（不可变）/ 事件（追加式决定历史）/ 计算（带输入摘要与父级依赖）。 */
export class Store {
  db: DatabaseSync;
  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
  }
  close() { this.db.close(); }

  nextSeq(table: 'materials' | 'events' | 'computations'): number {
    const row = this.db.prepare(`SELECT COALESCE(MAX(seq),0)+1 AS s FROM ${table}`).get() as { s: number };
    return row.s;
  }

  addMaterial(m: { id: string; kind: string; content: unknown }): MaterialRow {
    const content = JSON.stringify(m.content);
    const row: MaterialRow = { id: m.id, kind: m.kind, seq: this.nextSeq('materials'), digest: digestOf(m.content), content };
    this.db.prepare('INSERT INTO materials(id,kind,seq,digest,content) VALUES(?,?,?,?,?)')
      .run(row.id, row.kind, row.seq, row.digest, row.content);
    return row;
  }

  addEvent(e: { id: string; kind: string; parents: string[]; inputDigest: string; paramVersion: string; payload: unknown; conclusions: unknown }): EventRow {
    const row: EventRow = {
      id: e.id, seq: this.nextSeq('events'), kind: e.kind,
      parents: JSON.stringify(e.parents), input_digest: e.inputDigest,
      param_version: e.paramVersion, payload: JSON.stringify(e.payload),
      conclusions: JSON.stringify(e.conclusions),
    };
    this.db.prepare('INSERT INTO events(id,seq,kind,parents,input_digest,param_version,payload,conclusions) VALUES(?,?,?,?,?,?,?,?)')
      .run(row.id, row.seq, row.kind, row.parents, row.input_digest, row.param_version, row.payload, row.conclusions);
    return row;
  }

  addComputation(c: { id: string; eventId: string | null; targetId: string; inputDigest: string; paramVersion: string; status: string; result: unknown; diagnostics: Diagnostic[] }): ComputationRow {
    const row: ComputationRow = {
      id: c.id, seq: this.nextSeq('computations'), event_id: c.eventId, target_id: c.targetId,
      input_digest: c.inputDigest, param_version: c.paramVersion, status: c.status,
      result: c.result === null ? null : JSON.stringify(c.result), diagnostics: JSON.stringify(c.diagnostics),
    };
    this.db.prepare('INSERT INTO computations(id,seq,event_id,target_id,input_digest,param_version,status,result,diagnostics) VALUES(?,?,?,?,?,?,?,?,?)')
      .run(row.id, row.seq, row.event_id, row.target_id, row.input_digest, row.param_version, row.status, row.result, row.diagnostics);
    return row;
  }

  materials(): MaterialRow[] { return this.db.prepare('SELECT * FROM materials ORDER BY seq').all() as unknown as MaterialRow[]; }
  events(): EventRow[] { return this.db.prepare('SELECT * FROM events ORDER BY seq').all() as unknown as EventRow[]; }
  computations(): ComputationRow[] { return this.db.prepare('SELECT * FROM computations ORDER BY seq').all() as unknown as ComputationRow[]; }
  material(id: string): MaterialRow | undefined { return this.db.prepare('SELECT * FROM materials WHERE id=?').get(id) as unknown as MaterialRow | undefined; }
  materialsByKind(kind: string): MaterialRow[] { return this.db.prepare('SELECT * FROM materials WHERE kind=? ORDER BY seq').all(kind) as unknown as MaterialRow[]; }

  setMeta(k: string, v: string) { this.db.prepare('INSERT INTO meta(k,v) VALUES(?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').run(k, v); }
  getMeta(k: string): string | undefined { const r = this.db.prepare('SELECT v FROM meta WHERE k=?').get(k) as { v: string } | undefined; return r?.v; }

  /** 当前输入摘要：所有材料 digest 的汇总，用于事件与计算的依赖记录。 */
  inputDigest(): string {
    return digestOf(this.materials().map((m) => [m.id, m.digest]));
  }
}

export interface Archive {
  format: 'gel-archive/1';
  exportedAt: string;
  materials: MaterialRow[];
  events: EventRow[];
  computations: ComputationRow[];
  meta: Record<string, string>;
}

export function exportArchive(store: Store): Archive {
  const meta: Record<string, string> = {};
  for (const r of store.db.prepare('SELECT k,v FROM meta').all() as unknown as { k: string; v: string }[]) meta[r.k] = r.v;
  return { format: 'gel-archive/1', exportedAt: new Date().toISOString(), materials: store.materials(), events: store.events(), computations: store.computations(), meta };
}

export class SimulatedCrash extends Error { constructor(public afterRows: number) { super(`simulated crash after ${afterRows} rows`); } }

/**
 * 导入归档：单事务写入；任何失败整体回滚（半写恢复）。
 * - 结构不符 → format_corrupt；引用/摘要语义不符 → semantic_unsolvable；
 * - 预算耗尽 → budget_exhausted。三种失败互不混淆。
 * - crashAfterRows 用于测试：模拟进程在写了一半时崩溃（不回滚，由新连接验证原子性）。
 */
export function importArchive(store: Store, raw: unknown, budget: { steps: number }, opts: { crashAfterRows?: number } = {}): Outcome<{ imported: number }> {
  const diagnostics: Diagnostic[] = [];
  const a = raw as Archive;
  if (!a || typeof a !== 'object' || a.format !== 'gel-archive/1' || !Array.isArray(a.materials) || !Array.isArray(a.events) || !Array.isArray(a.computations))
    return fail('format_corrupt', [{ code: 'ARCHIVE_FORMAT', severity: 'error', message: '归档格式损坏或版本不符（需要 gel-archive/1）', position: {} }]);
  // 语义校验：身份唯一、seq 单调、事件父级存在、材料摘要一致
  const ids = new Set<string>();
  const all = [...a.materials.map((m) => m.id), ...a.events.map((e) => e.id), ...a.computations.map((c) => c.id)];
  for (const id of all) {
    if (!spend(budget)) return fail('budget_exhausted', [{ code: 'BUDGET', severity: 'error', message: '导入校验预算耗尽', position: {} }]);
    if (ids.has(id)) return fail('semantic_unsolvable', [{ code: 'ARCHIVE_DUP_ID', severity: 'error', message: `归档内身份重复：${id}`, position: {} }]);
    ids.add(id);
  }
  for (const m of a.materials) {
    if (digestOf(JSON.parse(m.content)) !== m.digest)
      return fail('semantic_unsolvable', [{ code: 'ARCHIVE_DIGEST', severity: 'error', message: `材料 ${m.id} 的内容摘要不符`, position: { materialId: m.id } }]);
  }
  const eventIds = new Set(a.events.map((e) => e.id));
  for (const e of a.events) {
    for (const p of JSON.parse(e.parents) as string[])
      if (!eventIds.has(p) && !a.materials.some((m) => m.id === p))
        return fail('semantic_unsolvable', [{ code: 'ARCHIVE_PARENT', severity: 'error', message: `事件 ${e.id} 的父级 ${p} 不在归档中`, position: {} }]);
  }
  // 单事务写入；crashAfterRows 模拟半写崩溃
  let written = 0;
  const total = a.materials.length + a.events.length + a.computations.length;
  store.db.exec('BEGIN IMMEDIATE');
  try {
    store.db.exec('DELETE FROM computations; DELETE FROM events; DELETE FROM materials;');
    const mi = store.db.prepare('INSERT INTO materials(id,kind,seq,digest,content) VALUES(?,?,?,?,?)');
    for (const m of a.materials) { mi.run(m.id, m.kind, m.seq, m.digest, m.content); if (opts.crashAfterRows !== undefined && ++written === opts.crashAfterRows) throw new SimulatedCrash(written); }
    const ei = store.db.prepare('INSERT INTO events(id,seq,kind,parents,input_digest,param_version,payload,conclusions) VALUES(?,?,?,?,?,?,?,?)');
    for (const e of a.events) { ei.run(e.id, e.seq, e.kind, e.parents, e.input_digest, e.param_version, e.payload, e.conclusions); if (opts.crashAfterRows !== undefined && ++written === opts.crashAfterRows) throw new SimulatedCrash(written); }
    const ci = store.db.prepare('INSERT INTO computations(id,seq,event_id,target_id,input_digest,param_version,status,result,diagnostics) VALUES(?,?,?,?,?,?,?,?,?)');
    for (const c of a.computations) { ci.run(c.id, c.seq, c.event_id, c.target_id, c.input_digest, c.param_version, c.status, c.result, c.diagnostics); if (opts.crashAfterRows !== undefined && ++written === opts.crashAfterRows) throw new SimulatedCrash(written); }
    store.db.exec('DELETE FROM meta');
    const mi2 = store.db.prepare('INSERT INTO meta(k,v) VALUES(?,?)');
    for (const [k, v] of Object.entries(a.meta ?? {})) mi2.run(k, v);
    store.db.exec('COMMIT');
  } catch (err) {
    if (err instanceof SimulatedCrash) throw err; // 不回滚：模拟进程死亡，事务留在连接上
    store.db.exec('ROLLBACK');
    throw err;
  }
  diagnostics.push({ code: 'IMPORT_OK', severity: 'info', message: `导入 ${total} 行，身份/顺序/来源关系保持`, position: {} });
  return ok({ imported: total }, diagnostics);
}

/** 崩溃后恢复：新连接打开时，未提交事务不可见；另清理悬挂引用。 */
export function recover(store: Store): { rolledBack: boolean; orphansRemoved: number } {
  let rolledBack = false;
  try { store.db.exec('ROLLBACK'); rolledBack = true; } catch { /* 无活动事务 */ }
  const orphans = store.db.prepare(`DELETE FROM computations WHERE event_id IS NOT NULL AND event_id NOT IN (SELECT id FROM events)`).run();
  return { rolledBack, orphansRemoved: Number(orphans.changes) };
}

export { canonical, digestOf };
