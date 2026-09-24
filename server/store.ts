import type { DatabaseSync } from "node:sqlite";
import { digestOf } from "../shared/ids.js";
import type { EventEnvelope } from "../shared/events.js";

export interface MaterialRow {
  id: string;
  kind: string;
  laneIndex: number | null;
  version: number;
  payload: unknown;
  digest: string;
}

export interface DerivedRow {
  id: string;
  kind: string;
  laneIndex: number | null;
  payload: unknown;
  digest: string;
  inputDigest: string;
  paramVersion: string;
  parents: string[];
}

export interface DecisionRow {
  id: string;
  subjectId: string;
  action: string;
  payload: unknown;
}

export type RefKind = "material" | "derived" | "decision" | "event";

/**
 * 分层存储：不可变材料 / 派生结果 / 可修改决定 / 事件日志。
 * 对象全局内容寻址；refs 表把对象挂到分支（分支即视图）；
 * 失效是分支局部的记录，不改动对象本身。
 */
export class Store {
  constructor(readonly db: DatabaseSync) {}

  nextSeq(): number {
    this.db.prepare(`UPDATE meta SET value = CAST(value AS INTEGER) + 1 WHERE key = 'seq'`).run();
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'seq'`).get() as { value: string };
    return Number(row.value);
  }

  currentSeq(): number {
    const row = this.db.prepare(`SELECT value FROM meta WHERE key = 'seq'`).get() as { value: string };
    return Number(row.value);
  }

  tx<T>(fn: () => T): T {
    this.db.exec("BEGIN");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  putProject(id: string, name: string): void {
    this.db.prepare(`INSERT OR IGNORE INTO projects (id, name) VALUES (?, ?)`).run(id, name);
  }

  listProjects(): { id: string; name: string }[] {
    return this.db.prepare(`SELECT id, name FROM projects ORDER BY id`).all() as { id: string; name: string }[];
  }

  putBranch(id: string, projectId: string, name: string, parentId: string | null): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO branches (id, project_id, name, parent_id) VALUES (?, ?, ?, ?)`)
      .run(id, projectId, name, parentId);
  }

  listBranches(projectId: string): { id: string; name: string; parentId: string | null }[] {
    const rows = this.db
      .prepare(`SELECT id, name, parent_id AS parentId FROM branches WHERE project_id = ? ORDER BY id`)
      .all(projectId) as { id: string; name: string; parentId: string | null }[];
    return rows;
  }

  putMaterial(m: { id: string; kind: string; laneIndex: number | null; version: number; payload: unknown }): MaterialRow {
    const digest = digestOf(m.payload);
    this.db
      .prepare(`INSERT OR IGNORE INTO materials (id, kind, lane_index, version, payload, digest) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(m.id, m.kind, m.laneIndex, m.version, JSON.stringify(m.payload), digest);
    return { ...m, digest };
  }

  putDerived(d: {
    id: string;
    kind: string;
    laneIndex: number | null;
    payload: unknown;
    inputDigest: string;
    paramVersion: string;
    parents: string[];
  }): DerivedRow {
    const digest = digestOf(d.payload);
    this.db
      .prepare(
        `INSERT OR IGNORE INTO derived (id, kind, lane_index, payload, digest, input_digest, param_version, parents) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(d.id, d.kind, d.laneIndex, JSON.stringify(d.payload), digest, d.inputDigest, d.paramVersion, JSON.stringify(d.parents));
    return { ...d, digest };
  }

  putDecision(d: { id: string; subjectId: string; action: string; payload: unknown }): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO decisions (id, subject_id, action, payload) VALUES (?, ?, ?, ?)`)
      .run(d.id, d.subjectId, d.action, JSON.stringify(d.payload));
  }

  appendEvent(e: Omit<EventEnvelope, "id" | "seq" | "createdAt"> & { id: string; createdAt?: string }): EventEnvelope {
    const seq = this.nextSeq();
    const env: EventEnvelope = {
      id: e.id,
      seq,
      type: e.type,
      branchId: e.branchId,
      payload: e.payload,
      parents: e.parents,
      inputDigest: e.inputDigest,
      paramVersion: e.paramVersion,
      createdAt: e.createdAt ?? new Date().toISOString(),
    };
    this.db
      .prepare(
        `INSERT OR IGNORE INTO events (id, seq, type, branch_id, payload, parents, input_digest, param_version, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(env.id, env.seq, env.type, env.branchId, JSON.stringify(env.payload), JSON.stringify(env.parents), env.inputDigest, env.paramVersion, env.createdAt);
    this.link(env.branchId, "event", env.id, seq);
    return env;
  }

  link(branchId: string, kind: RefKind, objectId: string, seq?: number): void {
    const s = seq ?? this.nextSeq();
    this.db
      .prepare(`INSERT OR IGNORE INTO refs (branch_id, kind, object_id, seq) VALUES (?, ?, ?, ?)`)
      .run(branchId, kind, objectId, s);
  }

  invalidate(branchId: string, objectId: string, reason: string, seq: number): void {
    this.db
      .prepare(`INSERT OR IGNORE INTO invalidations (branch_id, object_id, reason, seq) VALUES (?, ?, ?, ?)`)
      .run(branchId, objectId, reason, seq);
  }

  invalidations(branchId: string): { objectId: string; reason: string; seq: number }[] {
    return this.db
      .prepare(`SELECT object_id AS objectId, reason, seq FROM invalidations WHERE branch_id = ? ORDER BY seq`)
      .all(branchId) as { objectId: string; reason: string; seq: number }[];
  }

  private refIds(branchId: string, kind: RefKind): { objectId: string; seq: number }[] {
    return this.db
      .prepare(`SELECT object_id AS objectId, seq FROM refs WHERE branch_id = ? AND kind = ? ORDER BY seq, object_id`)
      .all(branchId, kind) as { objectId: string; seq: number }[];
  }

  materials(branchId: string): (MaterialRow & { seq: number })[] {
    const refs = this.refIds(branchId, "material");
    if (refs.length === 0) return [];
    const stmt = this.db.prepare(`SELECT id, kind, lane_index AS laneIndex, version, payload, digest FROM materials WHERE id = ?`);
    const out: (MaterialRow & { seq: number })[] = [];
    for (const ref of refs) {
      const row = stmt.get(ref.objectId) as Omit<MaterialRow, "payload"> & { payload: string } | undefined;
      if (row) out.push({ ...row, payload: JSON.parse(row.payload), seq: ref.seq });
    }
    return out;
  }

  derived(branchId: string): (DerivedRow & { seq: number })[] {
    const refs = this.refIds(branchId, "derived");
    if (refs.length === 0) return [];
    const stmt = this.db.prepare(
      `SELECT id, kind, lane_index AS laneIndex, payload, digest, input_digest AS inputDigest, param_version AS paramVersion, parents FROM derived WHERE id = ?`,
    );
    const out: (DerivedRow & { seq: number })[] = [];
    for (const ref of refs) {
      const row = stmt.get(ref.objectId) as (Omit<DerivedRow, "payload" | "parents"> & { payload: string; parents: string }) | undefined;
      if (row) out.push({ ...row, payload: JSON.parse(row.payload), parents: JSON.parse(row.parents), seq: ref.seq });
    }
    return out;
  }

  decisions(branchId: string): (DecisionRow & { seq: number })[] {
    const refs = this.refIds(branchId, "decision");
    if (refs.length === 0) return [];
    const stmt = this.db.prepare(`SELECT id, subject_id AS subjectId, action, payload FROM decisions WHERE id = ?`);
    const out: (DecisionRow & { seq: number })[] = [];
    for (const ref of refs) {
      const row = stmt.get(ref.objectId) as (Omit<DecisionRow, "payload"> & { payload: string }) | undefined;
      if (row) out.push({ ...row, payload: JSON.parse(row.payload), seq: ref.seq });
    }
    return out;
  }

  events(branchId: string): EventEnvelope[] {
    const rows = this.db
      .prepare(
        `SELECT e.id, e.seq, e.type, e.branch_id AS branchId, e.payload, e.parents, e.input_digest AS inputDigest, e.param_version AS paramVersion, e.created_at AS createdAt
         FROM events e JOIN refs r ON r.object_id = e.id AND r.kind = 'event'
         WHERE r.branch_id = ? ORDER BY e.seq`,
      )
      .all(branchId) as (Omit<EventEnvelope, "payload" | "parents"> & { payload: string; parents: string })[];
    return rows.map((r) => ({ ...r, payload: JSON.parse(r.payload), parents: JSON.parse(r.parents) }));
  }

  getMaterial(id: string): MaterialRow | null {
    const row = this.db
      .prepare(`SELECT id, kind, lane_index AS laneIndex, version, payload, digest FROM materials WHERE id = ?`)
      .get(id) as (Omit<MaterialRow, "payload"> & { payload: string }) | undefined;
    return row ? { ...row, payload: JSON.parse(row.payload) } : null;
  }

  getDerived(id: string): DerivedRow | null {
    const row = this.db
      .prepare(
        `SELECT id, kind, lane_index AS laneIndex, payload, digest, input_digest AS inputDigest, param_version AS paramVersion, parents FROM derived WHERE id = ?`,
      )
      .get(id) as (Omit<DerivedRow, "payload" | "parents"> & { payload: string; parents: string }) | undefined;
    return row ? { ...row, payload: JSON.parse(row.payload), parents: JSON.parse(row.parents) } : null;
  }

  /** 导出：项目的全部表，按稳定顺序。 */
  dumpProject(projectId: string): Record<string, unknown[]> {
    const q = (sql: string) => this.db.prepare(sql).all(projectId) as unknown[];
    return {
      projects: q(`SELECT * FROM projects WHERE id = ?`),
      branches: q(`SELECT * FROM branches WHERE project_id = ? ORDER BY id`),
      materials: this.db.prepare(`SELECT DISTINCT m.* FROM materials m JOIN refs r ON r.object_id = m.id AND r.kind = 'material' JOIN branches b ON b.id = r.branch_id WHERE b.project_id = ? ORDER BY m.id`).all(projectId) as unknown[],
      derived: this.db.prepare(`SELECT DISTINCT d.* FROM derived d JOIN refs r ON r.object_id = d.id AND r.kind = 'derived' JOIN branches b ON b.id = r.branch_id WHERE b.project_id = ? ORDER BY d.id`).all(projectId) as unknown[],
      decisions: this.db.prepare(`SELECT DISTINCT d.* FROM decisions d JOIN refs r ON r.object_id = d.id AND r.kind = 'decision' JOIN branches b ON b.id = r.branch_id WHERE b.project_id = ? ORDER BY d.id`).all(projectId) as unknown[],
      events: this.db.prepare(`SELECT DISTINCT e.* FROM events e JOIN refs r ON r.object_id = e.id AND r.kind = 'event' JOIN branches b ON b.id = r.branch_id WHERE b.project_id = ? ORDER BY e.seq, e.id`).all(projectId) as unknown[],
      refs: this.db.prepare(`SELECT r.* FROM refs r JOIN branches b ON b.id = r.branch_id WHERE b.project_id = ? ORDER BY r.branch_id, r.kind, r.seq, r.object_id`).all(projectId) as unknown[],
      invalidations: this.db.prepare(`SELECT i.* FROM invalidations i JOIN branches b ON b.id = i.branch_id WHERE b.project_id = ? ORDER BY i.branch_id, i.seq`).all(projectId) as unknown[],
    };
  }

  /** 导入：单事务替换项目全部数据（身份、顺序、来源关系原样恢复）。 */
  replaceProject(projectId: string, tables: Record<string, Record<string, unknown>[]>): void {
    this.tx(() => {
      const branchIds = (tables.branches ?? []).map((b) => String(b.id));
      const delRefs = this.db.prepare(`DELETE FROM refs WHERE branch_id = ?`);
      const delInv = this.db.prepare(`DELETE FROM invalidations WHERE branch_id = ?`);
      for (const bid of branchIds) {
        delRefs.run(bid);
        delInv.run(bid);
      }
      this.db.prepare(`DELETE FROM branches WHERE project_id = ?`).run(projectId);
      this.db.prepare(`DELETE FROM projects WHERE id = ?`).run(projectId);
      // 对象表只删不再被任何分支引用的行
      this.db.exec(`
        DELETE FROM materials WHERE id NOT IN (SELECT object_id FROM refs WHERE kind = 'material');
        DELETE FROM derived WHERE id NOT IN (SELECT object_id FROM refs WHERE kind = 'derived');
        DELETE FROM decisions WHERE id NOT IN (SELECT object_id FROM refs WHERE kind = 'decision');
        DELETE FROM events WHERE id NOT IN (SELECT object_id FROM refs WHERE kind = 'event');
      `);
      const ins = (table: string, rows: Record<string, unknown>[]) => {
        for (const row of rows ?? []) {
          const cols = Object.keys(row);
          const sql = `INSERT OR REPLACE INTO ${table} (${cols.join(",")}) VALUES (${cols.map(() => "?").join(",")})`;
          this.db.prepare(sql).run(...cols.map((c) => row[c] as string | number | null));
        }
      };
      ins("projects", tables.projects ?? []);
      ins("branches", tables.branches ?? []);
      ins("materials", tables.materials ?? []);
      ins("derived", tables.derived ?? []);
      ins("decisions", tables.decisions ?? []);
      ins("events", tables.events ?? []);
      ins("refs", tables.refs ?? []);
      ins("invalidations", tables.invalidations ?? []);
      // seq 计数器至少覆盖导入的最大 seq
      let maxSeq = this.currentSeq();
      for (const e of tables.events ?? []) maxSeq = Math.max(maxSeq, Number(e.seq));
      for (const r of tables.refs ?? []) maxSeq = Math.max(maxSeq, Number(r.seq));
      this.db.prepare(`UPDATE meta SET value = ? WHERE key = 'seq'`).run(String(maxSeq));
    });
  }
}
