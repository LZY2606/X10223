/**
 * SQLite 存储层（node:sqlite，无原生依赖）。
 * - 所有多行写入在事务内完成；
 * - intents 表支持半写恢复：崩溃留下的孤儿行在下次打开时清除；
 * - 身份、顺序（seq）、来源关系在导出/导入往返中保持不变。
 */
import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type {
  ComputationRecord,
  Decision,
  DomainEvent,
  Material,
  Project,
} from "../shared/types";
import { newId, nowIso } from "../shared/util";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  seq_counter INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS materials (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  seq INTEGER NOT NULL,
  raw_json TEXT NOT NULL,
  normalized_json TEXT,
  source_json TEXT,
  digest TEXT NOT NULL,
  parent_material_id TEXT,
  superseded_at_seq INTEGER,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS images (
  material_id TEXT PRIMARY KEY,
  png BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS computations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  rule_version TEXT NOT NULL,
  input_digest TEXT NOT NULL,
  parent_event_id TEXT,
  depends_materials_json TEXT NOT NULL,
  depends_decisions_json TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS decisions (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  action TEXT NOT NULL,
  target_material_id TEXT,
  target_estimate_id TEXT,
  payload_json TEXT NOT NULL,
  rationale TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  type TEXT NOT NULL,
  payload_json TEXT NOT NULL,
  computation_id TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS intents (
  op_id TEXT NOT NULL,
  table_name TEXT NOT NULL,
  row_id TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_materials_project ON materials(project_id, seq);
CREATE INDEX IF NOT EXISTS idx_events_project ON events(project_id, seq);
`;

export class GelStore {
  readonly db: DatabaseSync;

  constructor(readonly path: string) {
    if (path !== ":memory:") mkdirSync(dirname(path), { recursive: true });
    this.db = new DatabaseSync(path);
    this.db.exec("PRAGMA journal_mode = WAL;");
    this.db.exec("PRAGMA foreign_keys = ON;");
    this.db.exec(SCHEMA);
    this.recoverIntents();
  }

  close() {
    this.db.close();
  }

  /** 半写恢复：清除崩溃遗留的孤儿行。 */
  private recoverIntents() {
    const rows = this.db
      .prepare("SELECT op_id, table_name, row_id FROM intents")
      .all() as Array<{ op_id: string; table_name: string; row_id: string }>;
    if (rows.length === 0) return;
    const allowed = new Set(["materials", "images", "computations", "decisions", "events"]);
    const keyCols: Record<string, string> = {
      materials: "id",
      images: "material_id",
      computations: "id",
      decisions: "id",
      events: "id",
    };
    this.db.exec("BEGIN");
    try {
      for (const r of rows) {
        if (!allowed.has(r.table_name)) continue;
        this.db
          .prepare(`DELETE FROM ${r.table_name} WHERE ${keyCols[r.table_name]} = ?`)
          .run(r.row_id);
      }
      this.db.exec("DELETE FROM intents");
      this.db.exec("COMMIT");
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  /** 测试专用：模拟半写崩溃（无事务写入后留下 intent）。 */
  simulateCrashWrite(projectId: string) {
    const opId = newId();
    const matId = newId();
    this.db
      .prepare("INSERT INTO intents (op_id, table_name, row_id, created_at) VALUES (?,?,?,?)")
      .run(opId, "materials", matId, nowIso());
    this.db
      .prepare(
        `INSERT INTO materials (id, project_id, kind, seq, raw_json, digest, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(matId, projectId, "band-center", 999999, "{}", "orphan", nowIso());
    // 崩溃点：intent 未清除，事务未提交概念不存在（自动提交已落库）。
    return { opId, matId };
  }

  nextSeq(projectId: string): number {
    this.db
      .prepare("UPDATE projects SET seq_counter = seq_counter + 1 WHERE id = ?")
      .run(projectId);
    const row = this.db
      .prepare("SELECT seq_counter AS c FROM projects WHERE id = ?")
      .get(projectId) as { c: number };
    return row.c;
  }

  transaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const out = fn();
      this.db.exec("COMMIT");
      return out;
    } catch (e) {
      this.db.exec("ROLLBACK");
      throw e;
    }
  }

  createProject(name: string): Project {
    const p: Project = { id: newId(), name, createdAt: nowIso() };
    this.db
      .prepare("INSERT INTO projects (id, name, seq_counter, created_at) VALUES (?,?,0,?)")
      .run(p.id, p.name, p.createdAt);
    return p;
  }

  projects(): Project[] {
    return (
      this.db.prepare("SELECT id, name, created_at FROM projects ORDER BY created_at").all() as any[]
    ).map((r: any) => ({ id: r.id, name: r.name, createdAt: r.created_at }));
  }

  insertMaterial(m: Material) {
    this.db
      .prepare(
        `INSERT INTO materials (id, project_id, kind, seq, raw_json, normalized_json, source_json, digest, parent_material_id, superseded_at_seq, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        m.id,
        m.projectId,
        m.kind,
        m.seq,
        JSON.stringify(m.raw),
        m.normalized ? JSON.stringify(m.normalized) : null,
        m.source ? JSON.stringify(m.source) : null,
        m.digest,
        m.parentMaterialId ?? null,
        null,
        m.createdAt,
      );
  }

  supersedeMaterial(id: string, atSeq: number) {
    this.db.prepare("UPDATE materials SET superseded_at_seq = ? WHERE id = ?").run(atSeq, id);
  }

  putImage(materialId: string, png: Buffer) {
    this.db.prepare("INSERT INTO images (material_id, png) VALUES (?,?)").run(materialId, png);
  }

  getImage(materialId: string): Buffer | null {
    const row = this.db
      .prepare("SELECT png FROM images WHERE material_id = ?")
      .get(materialId) as { png: Buffer } | undefined;
    return row ? Buffer.from(row.png) : null;
  }

  materials(projectId: string, asOfSeq?: number): Material[] {
    const rows = this.db
      .prepare("SELECT * FROM materials WHERE project_id = ? ORDER BY seq, id")
      .all(projectId) as any[];
    return rows
      .map(rowToMaterial)
      .filter(
        (m: any) =>
          asOfSeq === undefined ||
          (m.seq <= asOfSeq && (m.supersededAtSeq == null || m.supersededAtSeq > asOfSeq)),
      );
  }

  material(id: string): Material | null {
    const row = this.db.prepare("SELECT * FROM materials WHERE id = ?").get(id) as any;
    return row ? rowToMaterial(row) : null;
  }

  insertComputation(c: ComputationRecord, seq: number) {
    this.db
      .prepare(
        `INSERT INTO computations (id, project_id, seq, rule_version, input_digest, parent_event_id, depends_materials_json, depends_decisions_json, payload_json, created_at)
         VALUES (?,?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        c.id,
        c.projectId,
        seq,
        c.ruleVersion,
        c.inputDigest,
        c.parentEventId ?? null,
        JSON.stringify(c.dependsOnMaterialIds),
        JSON.stringify(c.dependsOnDecisionIds),
        JSON.stringify({ segments: c.segments, estimates: c.estimates, diagnostics: c.diagnostics }),
        c.createdAt,
      );
  }

  computations(projectId: string, asOfSeq?: number): Array<ComputationRecord & { seq: number }> {
    const rows = this.db
      .prepare("SELECT * FROM computations WHERE project_id = ? ORDER BY seq, id")
      .all(projectId) as any[];
    return rows
      .filter((r) => asOfSeq === undefined || r.seq <= asOfSeq)
      .map((r) => ({
        id: r.id,
        projectId: r.project_id,
        seq: r.seq,
        ruleVersion: r.rule_version,
        inputDigest: r.input_digest,
        parentEventId: r.parent_event_id ?? undefined,
        dependsOnMaterialIds: JSON.parse(r.depends_materials_json),
        dependsOnDecisionIds: JSON.parse(r.depends_decisions_json),
        ...JSON.parse(r.payload_json),
        createdAt: r.created_at,
      }));
  }

  insertDecision(d: Decision, seq: number) {
    this.db
      .prepare(
        `INSERT INTO decisions (id, project_id, seq, action, target_material_id, target_estimate_id, payload_json, rationale, created_at)
         VALUES (?,?,?,?,?,?,?,?,?)`,
      )
      .run(
        d.id,
        d.projectId,
        seq,
        d.action,
        d.targetMaterialId ?? null,
        d.targetEstimateId ?? null,
        JSON.stringify(d.payload),
        d.rationale,
        d.createdAt,
      );
  }

  decisions(projectId: string, asOfSeq?: number): Array<Decision & { seq: number }> {
    const rows = this.db
      .prepare("SELECT * FROM decisions WHERE project_id = ? ORDER BY seq, id")
      .all(projectId) as any[];
    return rows
      .filter((r) => asOfSeq === undefined || r.seq <= asOfSeq)
      .map((r) => ({
        id: r.id,
        projectId: r.project_id,
        seq: r.seq,
        action: r.action,
        targetMaterialId: r.target_material_id ?? undefined,
        targetEstimateId: r.target_estimate_id ?? undefined,
        payload: JSON.parse(r.payload_json),
        rationale: r.rationale,
        createdAt: r.created_at,
      }));
  }

  insertEvent(e: DomainEvent) {
    this.db
      .prepare(
        `INSERT INTO events (id, project_id, seq, type, payload_json, computation_id, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(e.id, e.projectId, e.seq, e.type, JSON.stringify(e.payload), e.computationId ?? null, e.createdAt);
  }

  events(projectId: string, asOfSeq?: number): DomainEvent[] {
    const rows = this.db
      .prepare("SELECT * FROM events WHERE project_id = ? ORDER BY seq, id")
      .all(projectId) as any[];
    return rows
      .filter((r) => asOfSeq === undefined || r.seq <= asOfSeq)
      .map((r) => ({
        id: r.id,
        projectId: r.project_id,
        seq: r.seq,
        type: r.type,
        payload: JSON.parse(r.payload_json),
        computationId: r.computation_id ?? undefined,
        createdAt: r.created_at,
      }));
  }
}

function rowToMaterial(r: any): Material & { supersededAtSeq?: number | null } {
  return {
    id: r.id,
    projectId: r.project_id,
    kind: r.kind,
    seq: r.seq,
    raw: JSON.parse(r.raw_json),
    normalized: r.normalized_json ? JSON.parse(r.normalized_json) : undefined,
    source: r.source_json ? JSON.parse(r.source_json) : undefined,
    digest: r.digest,
    parentMaterialId: r.parent_material_id ?? undefined,
    supersededAtSeq: r.superseded_at_seq,
    createdAt: r.created_at,
  } as Material;
}
