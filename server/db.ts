/**
 * 存储层：SQLite（node:sqlite）。
 * - objects：不可变材料与对象版本，superseded_by 记录版本链；
 * - events：仅追加的事件日志（含机器可读判断事件），分支保留；
 * - computations：派生计算，带输入摘要/参数版本/父级依赖/有效时间；
 * - import_staging：导入两阶段提交的暂存区，崩溃后打开时恢复。
 */
import { DatabaseSync } from 'node:sqlite';
import { canonical, contentId, eventId, sha256 } from '../shared/ids.js';
import type {
  ComputationRecord,
  GelEvent,
  GelObject,
  GelObjectKind,
  ProjectBundle,
  TransferError as TE
} from '../shared/types.js';
import { TransferError } from '../shared/types.js';

export interface StoredObject<T extends GelObject = GelObject> {
  seq: number;
  supersededBy: string | null;
  data: T;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS seq_counter(id INTEGER PRIMARY KEY CHECK(id = 1), value INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS objects(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  hash TEXT NOT NULL,
  seq INTEGER NOT NULL,
  superseded_by TEXT,
  data TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events(
  id TEXT PRIMARY KEY,
  seq INTEGER NOT NULL,
  branch TEXT NOT NULL,
  type TEXT NOT NULL,
  parents TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS computations(
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL,
  band_id TEXT NOT NULL,
  param_version TEXT NOT NULL,
  input_hash TEXT NOT NULL,
  parents TEXT NOT NULL,
  result TEXT NOT NULL,
  diagnostics TEXT NOT NULL,
  created_seq INTEGER NOT NULL,
  superseded_seq INTEGER
);
CREATE TABLE IF NOT EXISTS import_staging(slot TEXT NOT NULL, ord INTEGER NOT NULL, payload TEXT NOT NULL);
`;

export class GelStore {
  private db: DatabaseSync;

  constructor(path = ':memory:') {
    this.db = new DatabaseSync(path);
    this.db.exec(SCHEMA);
    this.db.exec(`INSERT OR IGNORE INTO seq_counter(id, value) VALUES (1, 0)`);
    this.recoverIfNeeded();
  }

  close(): void {
    this.db.close();
  }

  /** 清空全部业务数据（保留 schema），用于重新播种。 */
  reset(): void {
    this.db.exec(`DELETE FROM objects`);
    this.db.exec(`DELETE FROM events`);
    this.db.exec(`DELETE FROM computations`);
    this.db.exec(`DELETE FROM import_staging`);
    this.db.exec(`UPDATE seq_counter SET value = 0 WHERE id = 1`);
  }

  /** 半写恢复：暂存区非空说明上次导入在合并前崩溃，丢弃暂存内容。 */
  recoverIfNeeded(): { recovered: boolean } {
    const row = this.db.prepare(`SELECT COUNT(*) AS n FROM import_staging`).get() as { n: number };
    if (row.n > 0) {
      this.db.exec(`DELETE FROM import_staging`);
      return { recovered: true };
    }
    return { recovered: false };
  }

  nextSeq(): number {
    this.db.exec(`UPDATE seq_counter SET value = value + 1 WHERE id = 1`);
    const row = this.db.prepare(`SELECT value FROM seq_counter WHERE id = 1`).get() as { value: number };
    return row.value;
  }

  currentSeq(): number {
    const row = this.db.prepare(`SELECT value FROM seq_counter WHERE id = 1`).get() as { value: number };
    return row.value;
  }

  appendEvent(type: string, payload: unknown, parents: string[] = [], branch = 'main'): GelEvent {
    const seq = this.nextSeq();
    const evt: GelEvent = {
      id: eventId(seq, type, payload),
      seq,
      branch,
      type,
      parents,
      payload,
      createdAt: new Date().toISOString()
    };
    this.db
      .prepare(`INSERT INTO events(id, seq, branch, type, parents, payload, created_at) VALUES (?,?,?,?,?,?,?)`)
      .run(evt.id, evt.seq, evt.branch, evt.type, JSON.stringify(evt.parents), JSON.stringify(evt.payload), evt.createdAt);
    return evt;
  }

  putObject(obj: GelObject): void {
    const seq = this.nextSeq();
    this.db
      .prepare(`INSERT OR IGNORE INTO objects(id, kind, hash, seq, superseded_by, data) VALUES (?,?,?,?,NULL,?)`)
      .run(obj.id, obj.kind, obj.hash, seq, JSON.stringify(obj));
  }

  /** 新版本替换旧版本：旧对象保留，标记 superseded_by。 */
  supersedeObject(oldId: string, newObj: GelObject): void {
    this.putObject(newObj);
    this.db.prepare(`UPDATE objects SET superseded_by = ? WHERE id = ?`).run(newObj.id, oldId);
  }

  objectById<T extends GelObject = GelObject>(id: string): T | undefined {
    const row = this.db.prepare(`SELECT data FROM objects WHERE id = ?`).get(id) as { data: string } | undefined;
    return row ? (JSON.parse(row.data) as T) : undefined;
  }

  objects(kind?: GelObjectKind, opts: { currentOnly?: boolean } = {}): StoredObject[] {
    let sql = `SELECT seq, superseded_by, data FROM objects`;
    const conds: string[] = [];
    const params: string[] = [];
    if (kind) {
      conds.push(`kind = ?`);
      params.push(kind);
    }
    if (opts.currentOnly) conds.push(`superseded_by IS NULL`);
    if (conds.length) sql += ` WHERE ` + conds.join(' AND ');
    sql += ` ORDER BY seq ASC`;
    const rows = this.db.prepare(sql).all(...params) as { seq: number; superseded_by: string | null; data: string }[];
    return rows.map((r) => ({ seq: r.seq, supersededBy: r.superseded_by, data: JSON.parse(r.data) as GelObject }));
  }

  events(opts: { branch?: string; upToSeq?: number } = {}): GelEvent[] {
    let sql = `SELECT id, seq, branch, type, parents, payload, created_at FROM events`;
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (opts.branch) {
      conds.push(`branch = ?`);
      params.push(opts.branch);
    }
    if (opts.upToSeq !== undefined) {
      conds.push(`seq <= ?`);
      params.push(opts.upToSeq);
    }
    if (conds.length) sql += ` WHERE ` + conds.join(' AND ');
    sql += ` ORDER BY seq ASC, id ASC`;
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      seq: r.seq,
      branch: r.branch,
      type: r.type,
      parents: JSON.parse(r.parents),
      payload: JSON.parse(r.payload),
      createdAt: r.created_at
    }));
  }

  eventById(id: string): GelEvent | undefined {
    return this.events().find((e) => e.id === id);
  }

  insertComputation(rec: Omit<ComputationRecord, 'createdSeq' | 'supersededSeq'>): ComputationRecord {
    const seq = this.nextSeq();
    const full: ComputationRecord = { ...rec, createdSeq: seq, supersededSeq: null };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO computations(id, kind, band_id, param_version, input_hash, parents, result, diagnostics, created_seq, superseded_seq)
         VALUES (?,?,?,?,?,?,?,?,?,NULL)`
      )
      .run(
        full.id,
        full.kind,
        full.bandId,
        full.paramVersion,
        full.inputHash,
        JSON.stringify(full.parents),
        JSON.stringify(full.result),
        JSON.stringify(full.diagnostics),
        full.createdSeq
      );
    return full;
  }

  supersedeComputation(id: string): void {
    const seq = this.nextSeq();
    this.db.prepare(`UPDATE computations SET superseded_seq = ? WHERE id = ? AND superseded_seq IS NULL`).run(seq, id);
  }

  computations(opts: { upToSeq?: number; bandId?: string } = {}): ComputationRecord[] {
    let sql = `SELECT * FROM computations`;
    const conds: string[] = [];
    const params: (string | number)[] = [];
    if (opts.upToSeq !== undefined) {
      conds.push(`created_seq <= ?`);
      params.push(opts.upToSeq);
    }
    if (opts.bandId) {
      conds.push(`band_id = ?`);
      params.push(opts.bandId);
    }
    if (conds.length) sql += ` WHERE ` + conds.join(' AND ');
    sql += ` ORDER BY created_seq ASC, id ASC`;
    const rows = this.db.prepare(sql).all(...params) as any[];
    return rows.map((r) => ({
      id: r.id,
      kind: r.kind,
      bandId: r.band_id,
      paramVersion: r.param_version,
      inputHash: r.input_hash,
      parents: JSON.parse(r.parents),
      result: JSON.parse(r.result),
      diagnostics: JSON.parse(r.diagnostics),
      createdSeq: r.created_seq,
      supersededSeq: r.superseded_seq
    }));
  }

  /** 有效时间视图：seq 时刻可见的计算（未在该时刻前被取代）。 */
  visibleComputationsAt(seq: number): ComputationRecord[] {
    return this.computations({ upToSeq: seq }).filter((c) => c.supersededSeq === null || c.supersededSeq > seq);
  }

  /** 决定状态：由决定事件推导，截至 seq。 */
  decisionStatusAt(seq: number): Map<string, { action: string; branch: string; eventSeq: number }> {
    const map = new Map<string, { action: string; branch: string; eventSeq: number }>();
    for (const e of this.events({ upToSeq: seq })) {
      if (e.type.startsWith('decision.')) {
        const p = e.payload as { targetId: string; action: string };
        map.set(p.targetId, { action: p.action, branch: e.branch, eventSeq: e.seq });
      }
    }
    return map;
  }

  // ---------- 导出 / 导入 ----------

  exportBundle(): ProjectBundle {
    const objects = this.objects().map((o) => ({ ...o.data, seq: o.seq, supersededBy: o.supersededBy }));
    const events = this.events();
    const computations = this.computations();
    const core = { format: 'gel-scale-bundle/1', objects, events, computations };
    const checksum = sha256(canonical(core));
    return {
      format: 'gel-scale-bundle/1',
      exportedAt: new Date().toISOString(),
      objects: core.objects as ProjectBundle['objects'],
      events,
      computations,
      checksum
    };
  }

  /**
   * 导入：两阶段提交。
   * 阶段一（已提交）：写入暂存区；阶段二（单事务）：校验并合并后清空暂存区。
   * 崩溃发生在阶段一之后 -> 下次打开时 recoverIfNeeded 丢弃暂存，主表不受影响。
   */
  importBundle(
    raw: string,
    budget: { maxBytes: number; maxObjects: number } = { maxBytes: 8_000_000, maxObjects: 50_000 },
    hooks: { crashAfterStage?: boolean } = {}
  ): { objects: number; events: number; computations: number } {
    if (Buffer.byteLength(raw, 'utf8') > budget.maxBytes) {
      throw new TransferError('budget-exhausted', `导入包大小超过预算 ${budget.maxBytes} 字节`);
    }
    let bundle: ProjectBundle;
    try {
      bundle = JSON.parse(raw) as ProjectBundle;
    } catch {
      throw new TransferError('format-corrupt', '导入包不是合法 JSON');
    }
    if (bundle.format !== 'gel-scale-bundle/1' || !Array.isArray(bundle.objects) || !Array.isArray(bundle.events)) {
      throw new TransferError('format-corrupt', '导入包格式标识或结构不符', 'format');
    }
    const core = {
      format: bundle.format,
      objects: bundle.objects,
      events: bundle.events,
      computations: bundle.computations
    };
    if (sha256(canonical(core)) !== bundle.checksum) {
      throw new TransferError('format-corrupt', '导入包校验和不匹配，内容已损坏', 'checksum');
    }
    if (bundle.objects.length > budget.maxObjects) {
      throw new TransferError('budget-exhausted', `对象数量 ${bundle.objects.length} 超过预算 ${budget.maxObjects}`);
    }
    // 语义校验：父级引用必须可解析（语义无解 ≠ 格式损坏）
    const knownIds = new Set<string>();
    for (const o of this.objects()) knownIds.add(o.data.id);
    for (const e of this.events()) knownIds.add(e.id);
    for (const o of bundle.objects) knownIds.add(o.id);
    for (const e of bundle.events) knownIds.add(e.id);
    for (const e of bundle.events) {
      for (const p of e.parents ?? []) {
        if (!knownIds.has(p)) {
          throw new TransferError('semantic-unsolvable', `事件 ${e.id} 引用了不存在的父级 ${p}`, `events[${e.id}].parents`);
        }
      }
    }
    for (const c of bundle.computations ?? []) {
      for (const p of c.parents ?? []) {
        if (!knownIds.has(p)) {
          throw new TransferError('semantic-unsolvable', `计算 ${c.id} 引用了不存在的父级 ${p}`, `computations[${c.id}].parents`);
        }
      }
    }

    // 阶段一：暂存（独立提交）
    this.db.exec(`DELETE FROM import_staging`);
    const stage = this.db.prepare(`INSERT INTO import_staging(slot, ord, payload) VALUES (?,?,?)`);
    bundle.objects.forEach((o, i) => stage.run('object', i, JSON.stringify(o)));
    bundle.events.forEach((e, i) => stage.run('event', i, JSON.stringify(e)));
    (bundle.computations ?? []).forEach((c, i) => stage.run('computation', i, JSON.stringify(c)));

    if (hooks.crashAfterStage) {
      throw new Error('simulated-crash-after-stage');
    }

    // 阶段二：单事务合并 + 清空暂存
    this.db.exec(`BEGIN`);
    try {
      const insObj = this.db.prepare(
        `INSERT OR IGNORE INTO objects(id, kind, hash, seq, superseded_by, data) VALUES (?,?,?,?,?,?)`
      );
      const insEvt = this.db.prepare(
        `INSERT OR IGNORE INTO events(id, seq, branch, type, parents, payload, created_at) VALUES (?,?,?,?,?,?,?)`
      );
      const insCmp = this.db.prepare(
        `INSERT OR IGNORE INTO computations(id, kind, band_id, param_version, input_hash, parents, result, diagnostics, created_seq, superseded_seq)
         VALUES (?,?,?,?,?,?,?,?,?,?)`
      );
      let maxSeq = this.currentSeq();
      for (const o of bundle.objects) {
        const { seq, supersededBy, ...data } = o as any;
        insObj.run(data.id, data.kind, data.hash, seq, supersededBy ?? null, JSON.stringify(data));
        if (seq > maxSeq) maxSeq = seq;
      }
      for (const e of bundle.events) {
        insEvt.run(e.id, e.seq, e.branch, e.type, JSON.stringify(e.parents), JSON.stringify(e.payload), e.createdAt);
        if (e.seq > maxSeq) maxSeq = e.seq;
      }
      for (const c of bundle.computations ?? []) {
        insCmp.run(
          c.id,
          c.kind,
          c.bandId,
          c.paramVersion,
          c.inputHash,
          JSON.stringify(c.parents),
          JSON.stringify(c.result),
          JSON.stringify(c.diagnostics),
          c.createdSeq,
          c.supersededSeq
        );
        if (c.createdSeq > maxSeq) maxSeq = c.createdSeq;
        if (c.supersededSeq && c.supersededSeq > maxSeq) maxSeq = c.supersededSeq;
      }
      this.db.prepare(`UPDATE seq_counter SET value = MAX(value, ?) WHERE id = 1`).run(maxSeq);
      this.db.exec(`DELETE FROM import_staging`);
      this.db.exec(`COMMIT`);
    } catch (err) {
      this.db.exec(`ROLLBACK`);
      throw err;
    }
    return {
      objects: bundle.objects.length,
      events: bundle.events.length,
      computations: (bundle.computations ?? []).length
    };
  }
}
