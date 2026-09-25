import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";
import type {
  Adjudication,
  DecisionEvent,
  FrameRef,
  Material,
  ParamRevisionEvent,
  ProjectEvent,
  ProjectState,
  RetractionEvent,
  BranchEvent
} from "../shared/domain.js";
import type { ParamPack } from "../shared/params.js";
import { DEFAULT_PARAMS, paramsWithVersion } from "../shared/params.js";
import { contentId, digestOf, sha256Hex } from "../shared/ids.js";
import { canonicalJson } from "../shared/canonical.js";
import { computeComputation } from "./calibration.js";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  base_params TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS blobs (
  id TEXT PRIMARY KEY,
  sha256 TEXT NOT NULL,
  media_type TEXT NOT NULL,
  data BLOB NOT NULL
);
CREATE TABLE IF NOT EXISTS materials (
  project_id TEXT NOT NULL,
  id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS events (
  project_id TEXT NOT NULL,
  seq INTEGER NOT NULL,
  id TEXT NOT NULL,
  branch TEXT NOT NULL,
  parent_event_id TEXT,
  kind TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (project_id, seq)
);
CREATE TABLE IF NOT EXISTS branches (
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  head_event_id TEXT,
  PRIMARY KEY (project_id, name)
);
CREATE TABLE IF NOT EXISTS computations (
  id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  payload TEXT NOT NULL,
  PRIMARY KEY (project_id, id)
);
CREATE TABLE IF NOT EXISTS evidence (
  project_id TEXT NOT NULL,
  computation_id TEXT NOT NULL,
  code TEXT NOT NULL,
  payload TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_sessions (
  id TEXT PRIMARY KEY,
  project_id TEXT,
  state TEXT NOT NULL,
  payload TEXT NOT NULL,
  created_at TEXT NOT NULL
);
`;

export interface ExportBundle {
  format: "gel-ruler-workbench-export/1";
  exportedAt: string;
  project: { id: string; name: string; createdAt: string; baseParams: ParamPack };
  materials: Material[];
  events: (ProjectEvent & { projectSeq: number })[];
  branches: { name: string; headEventId: string | null }[];
  blobs: { id: string; sha256: string; mediaType: string; dataBase64: string }[];
  digest: string;
}

export interface ImportResult {
  outcome: "ok" | "format-corrupt" | "semantic-unsolvable" | "budget-exhausted";
  code: string;
  message: string;
  position: string | null;
  projectId?: string;
}

const BUDGET = {
  maxBundleBytes: 32 * 1024 * 1024,
  maxEvents: 20000,
  maxMaterials: 50000,
  maxBlobBytes: 16 * 1024 * 1024
};

export class Store {
  readonly db: Database.Database;
  readonly dbPath: string;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    if (dbPath !== ":memory:") mkdirSync(path.dirname(dbPath), { recursive: true });
    this.db = new Database(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(SCHEMA);
    this.recoverIncompleteImports();
  }

  close(): void {
    this.db.close();
  }

  private recoverIncompleteImports(): void {
    const staging = this.db.prepare("SELECT id, project_id FROM import_sessions WHERE state = 'staging'").all() as { id: string; project_id: string | null }[];
    const cleanup = this.db.transaction(() => {
      for (const s of staging) {
        if (s.project_id) {
          this.db.prepare("DELETE FROM projects WHERE id = ?").run(s.project_id);
          this.db.prepare("DELETE FROM materials WHERE project_id = ?").run(s.project_id);
          this.db.prepare("DELETE FROM events WHERE project_id = ?").run(s.project_id);
          this.db.prepare("DELETE FROM branches WHERE project_id = ?").run(s.project_id);
          this.db.prepare("DELETE FROM computations WHERE project_id = ?").run(s.project_id);
          this.db.prepare("DELETE FROM evidence WHERE project_id = ?").run(s.project_id);
        }
        this.db.prepare("DELETE FROM import_sessions WHERE id = ?").run(s.id);
      }
    });
    cleanup();
  }

  createProject(name: string, baseParams: ParamPack = DEFAULT_PARAMS): string {
    const id = contentId("proj", { name, baseParams: baseParams.version });
    const existing = this.db.prepare("SELECT id FROM projects WHERE id = ?").get(id);
    if (existing) return id;
    this.db.prepare("INSERT INTO projects (id, name, created_at, base_params) VALUES (?, ?, ?, ?)").run(
      id,
      name,
      "2026-09-19T09:30:00+09:00",
      JSON.stringify(baseParams)
    );
    this.db.prepare("INSERT OR IGNORE INTO branches (project_id, name, head_event_id) VALUES (?, 'main', NULL)").run(id);
    return id;
  }

  projectExists(projectId: string): boolean {
    return !!this.db.prepare("SELECT id FROM projects WHERE id = ?").get(projectId);
  }

  listProjects(): { id: string; name: string; createdAt: string }[] {
    return (this.db.prepare("SELECT id, name, created_at AS createdAt FROM projects ORDER BY created_at, id").all() as { id: string; name: string; createdAt: string }[]);
  }

  deleteProject(projectId: string): void {
    const tx = this.db.transaction(() => {
      this.db.prepare("DELETE FROM projects WHERE id = ?").run(projectId);
      this.db.prepare("DELETE FROM materials WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM events WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM branches WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM computations WHERE project_id = ?").run(projectId);
      this.db.prepare("DELETE FROM evidence WHERE project_id = ?").run(projectId);
    });
    tx();
  }

  putBlob(data: Buffer, mediaType: string): string {
    const sha = sha256Hex(data);
    const id = contentId("blob", { sha256: sha, mediaType });
    this.db.prepare("INSERT OR IGNORE INTO blobs (id, sha256, media_type, data) VALUES (?, ?, ?, ?)").run(id, sha, mediaType, data);
    return id;
  }

  getBlob(id: string): { data: Buffer; mediaType: string } | null {
    const row = this.db.prepare("SELECT data, media_type AS mediaType FROM blobs WHERE id = ?").get(id) as { data: Buffer; mediaType: string } | undefined;
    return row ?? null;
  }

  addMaterials(projectId: string, materials: Material[]): { added: number; skipped: number } {
    const insert = this.db.prepare("INSERT OR IGNORE INTO materials (project_id, id, kind, payload) VALUES (?, ?, ?, ?)");
    let added = 0;
    let skipped = 0;
    const tx = this.db.transaction(() => {
      for (const m of materials) {
        const res = insert.run(projectId, m.id, m.kind, canonicalJson(m));
        if (res.changes > 0) added++;
        else skipped++;
      }
    });
    tx();
    return { added, skipped };
  }

  private allMaterials(projectId: string): Material[] {
    const rows = this.db.prepare("SELECT payload FROM materials WHERE project_id = ?").all(projectId) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as Material);
  }

  private allEvents(projectId: string): ProjectEvent[] {
    const rows = this.db.prepare("SELECT payload FROM events WHERE project_id = ? ORDER BY seq").all(projectId) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload) as ProjectEvent);
  }

  private branchHead(projectId: string, branch: string): string | null {
    const row = this.db.prepare("SELECT head_event_id AS h FROM branches WHERE project_id = ? AND name = ?").get(projectId, branch) as { h: string | null } | undefined;
    return row ? row.h : null;
  }

  private headSeq(projectId: string): number {
    const row = this.db.prepare("SELECT MAX(seq) AS s FROM events WHERE project_id = ?").get(projectId) as { s: number | null };
    return row.s ?? 0;
  }

  appendEvent(projectId: string, branch: string, event: Omit<DecisionEvent, "id" | "seq" | "branch" | "parentEventId"> | Omit<ParamRevisionEvent, "id" | "seq" | "branch" | "parentEventId"> | Omit<RetractionEvent, "id" | "seq" | "branch" | "parentEventId"> | Omit<BranchEvent, "id" | "seq" | "branch" | "parentEventId">): ProjectEvent {
    const parentEventId = this.branchHead(projectId, branch);
    const seq = this.headSeq(projectId) + 1;
    const id = contentId("evt", { projectId, branch, seq, parentEventId, ...event });
    const full = { ...event, id, seq, branch, parentEventId } as ProjectEvent;
    const tx = this.db.transaction(() => {
      this.db.prepare("INSERT INTO events (project_id, seq, id, branch, parent_event_id, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
        projectId, seq, id, branch, parentEventId, full.kind, canonicalJson(full)
      );
      if (full.kind === "branch") {
        this.db.prepare("INSERT OR IGNORE INTO branches (project_id, name, head_event_id) VALUES (?, ?, ?)").run(projectId, (full as BranchEvent).newBranch, parentEventId);
      }
      this.db.prepare("UPDATE branches SET head_event_id = ? WHERE project_id = ? AND name = ?").run(id, projectId, branch);
    });
    tx();
    return full;
  }

  private eventChain(projectId: string, branch: string, upToSeq?: number): ProjectEvent[] {
    const events = this.allEvents(projectId);
    const byId = new Map(events.map((e) => [e.id, e]));
    let headId = this.branchHead(projectId, branch);
    const chain: ProjectEvent[] = [];
    let cursor = headId;
    while (cursor) {
      const e = byId.get(cursor);
      if (!e) break;
      if (upToSeq === undefined || e.seq <= upToSeq) chain.push(e);
      cursor = e.parentEventId;
      if (upToSeq !== undefined && chain.length > 0 && (chain[chain.length - 1] as ProjectEvent).seq <= upToSeq) {
        // keep walking parents to collect older events below upToSeq
      }
    }
    chain.reverse();
    headId = headId ?? null;
    return chain;
  }

  getState(projectId: string, branch = "main", upToSeq?: number): ProjectState {
    const proj = this.db.prepare("SELECT id, name, base_params AS baseParams FROM projects WHERE id = ?").get(projectId) as { id: string; name: string; baseParams: string } | undefined;
    if (!proj) throw new Error(`project not found: ${projectId}`);
    const chain = this.eventChain(projectId, branch, upToSeq);
    const headSeq = this.headSeq(projectId);
    const baseParams = JSON.parse(proj.baseParams) as ParamPack;

    let params = baseParams;
    const retracted = new Set<string>();
    const specOverrides = new Map<string, string>();
    const decisions: DecisionEvent[] = [];
    for (const e of chain) {
      if (e.kind === "param-revision") {
        params = paramsWithVersion({ ...params, ...(e as ParamRevisionEvent).patch } as Partial<ParamPack>);
      } else if (e.kind === "retraction") {
        for (const id of (e as RetractionEvent).retractedMaterialIds) retracted.add(id);
      } else if (e.kind === "decision") {
        const d = e as DecisionEvent;
        decisions.push(d);
        if (d.targetKind === "calibration" && d.verb === "revise" && d.valueRaw) specOverrides.set(d.targetId, d.valueRaw);
      }
    }

    const allMaterials = this.allMaterials(projectId);
    const activeMaterials = allMaterials
      .filter((m) => !retracted.has(m.id))
      .map((m) => {
        if (m.kind === "lane" && specOverrides.has(m.id)) {
          return { ...m, ladderSpecId: specOverrides.get(m.id) as string };
        }
        return m;
      });

    const activeFrame: FrameRef = activeMaterials.some((m) => m.kind === "image" && m.frame === "rotated") ? "rotated" : "raw";
    const parentDependencyIds = [
      ...(chain.length ? [(chain[chain.length - 1] as ProjectEvent).id] : ["genesis"]),
      ...activeMaterials.map((m) => m.id).sort()
    ];
    const computation = computeComputation({ materials: activeMaterials, params, frame: activeFrame, parentDependencyIds });

    const upsertComp = this.db.prepare("INSERT OR REPLACE INTO computations (id, project_id, payload) VALUES (?, ?, ?)");
    upsertComp.run(computation.id, projectId, canonicalJson(computation));
    this.db.prepare("DELETE FROM evidence WHERE project_id = ? AND computation_id = ?").run(projectId, computation.id);
    const insertEvidence = this.db.prepare("INSERT INTO evidence (project_id, computation_id, code, payload) VALUES (?, ?, ?, ?)");
    for (const dgn of computation.diagnostics) {
      if (!dgn.code.startsWith("GEL-")) continue;
      insertEvidence.run(projectId, computation.id, dgn.code, canonicalJson({
        code: dgn.code,
        severity: dgn.severity,
        statement: dgn.message,
        basis: EVIDENCE_BASIS[dgn.code] ?? "规则包判定",
        frame: dgn.at.frame,
        affectedObjectIds: [dgn.at.laneId, dgn.at.bandId, dgn.at.segmentId].filter((x): x is string => !!x),
        computationId: computation.id,
        parametersVersion: computation.paramsVersion,
        positions: [dgn.at]
      }));
    }

    const adjudications: Record<string, Adjudication> = {};
    for (const d of decisions) {
      if (d.targetKind !== "band-mw") continue;
      adjudications[d.targetId] = {
        inferenceId: d.targetId,
        verb: d.verb,
        status: d.verb === "accept" ? "accepted" : d.verb === "reject" ? "rejected" : "manual",
        valueRaw: d.valueRaw,
        decisionId: d.id,
        author: d.author,
        rationale: d.rationale,
        at: d.at
      };
    }

    const branches: Record<string, string | null> = {};
    for (const row of this.db.prepare("SELECT name, head_event_id AS h FROM branches WHERE project_id = ?").all(projectId) as { name: string; h: string | null }[]) {
      branches[row.name] = row.h;
    }

    const materials: Record<string, Material> = {};
    for (const m of activeMaterials) materials[m.id] = m;

    return {
      projectId,
      name: proj.name,
      branch,
      branches,
      atEventId: chain.length ? (chain[chain.length - 1] as ProjectEvent).id : null,
      seq: chain.length ? (chain[chain.length - 1] as ProjectEvent).seq : 0,
      headSeq,
      params,
      paramsVersion: params.version,
      activeFrame,
      materials,
      retractedMaterialIds: [...retracted].sort(),
      events: chain,
      computation,
      adjudications
    };
  }

  listEvidence(projectId: string): unknown[] {
    const rows = this.db.prepare("SELECT payload FROM evidence WHERE project_id = ? ORDER BY rowid").all(projectId) as { payload: string }[];
    return rows.map((r) => JSON.parse(r.payload));
  }

  exportProject(projectId: string): ExportBundle {
    const proj = this.db.prepare("SELECT id, name, created_at AS createdAt, base_params AS baseParams FROM projects WHERE id = ?").get(projectId) as { id: string; name: string; createdAt: string; baseParams: string } | undefined;
    if (!proj) throw new Error(`project not found: ${projectId}`);
    const materials = this.allMaterials(projectId);
    const events = this.allEvents(projectId).map((e) => ({ ...e, projectSeq: e.seq }));
    const branches = (this.db.prepare("SELECT name, head_event_id AS headEventId FROM branches WHERE project_id = ?").all(projectId) as { name: string; headEventId: string | null }[]);
    const blobIds = new Set<string>();
    for (const m of materials) if (m.kind === "image") blobIds.add(m.blobId);
    const blobs = [...blobIds].map((id) => {
      const row = this.db.prepare("SELECT id, sha256, media_type AS mediaType, data FROM blobs WHERE id = ?").get(id) as { id: string; sha256: string; mediaType: string; data: Buffer };
      return { id: row.id, sha256: row.sha256, mediaType: row.mediaType, dataBase64: row.data.toString("base64") };
    });
    const core = {
      format: "gel-ruler-workbench-export/1" as const,
      project: { id: proj.id, name: proj.name, createdAt: proj.createdAt, baseParams: JSON.parse(proj.baseParams) as ParamPack },
      materials,
      events,
      branches,
      blobs
    };
    return { ...core, exportedAt: "2026-09-19T09:30:00+09:00", digest: digestOf(core) };
  }

  importProject(raw: string): ImportResult {
    if (Buffer.byteLength(raw, "utf8") > BUDGET.maxBundleBytes) {
      return { outcome: "budget-exhausted", code: "GEL-BUDGET-BYTES", message: `导出包超过 ${BUDGET.maxBundleBytes} 字节预算`, position: "$" };
    }
    let bundle: ExportBundle;
    try {
      bundle = JSON.parse(raw) as ExportBundle;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      const posMatch = /position (\d+)/.exec(msg);
      return { outcome: "format-corrupt", code: "GEL-FORMAT-JSON", message: `JSON 解析失败：${msg}`, position: posMatch ? `$.byte[${posMatch[1]}]` : "$" };
    }
    if (bundle.format !== "gel-ruler-workbench-export/1") {
      return { outcome: "format-corrupt", code: "GEL-FORMAT-KIND", message: `无法识别的导出格式「${String(bundle.format)}」`, position: "$.format" };
    }
    if (!bundle.project?.id || !Array.isArray(bundle.materials) || !Array.isArray(bundle.events) || !Array.isArray(bundle.branches) || !Array.isArray(bundle.blobs)) {
      return { outcome: "format-corrupt", code: "GEL-FORMAT-SCHEMA", message: "导出包缺少必需字段（project/materials/events/branches/blobs）", position: "$" };
    }
    if (bundle.events.length > BUDGET.maxEvents) {
      return { outcome: "budget-exhausted", code: "GEL-BUDGET-EVENTS", message: `事件数 ${bundle.events.length} 超过预算 ${BUDGET.maxEvents}`, position: "$.events" };
    }
    if (bundle.materials.length > BUDGET.maxMaterials) {
      return { outcome: "budget-exhausted", code: "GEL-BUDGET-MATERIALS", message: `材料数 ${bundle.materials.length} 超过预算 ${BUDGET.maxMaterials}`, position: "$.materials" };
    }
    const blobIds = new Set<string>();
    for (let i = 0; i < bundle.blobs.length; i++) {
      const b = bundle.blobs[i]!;
      const data = Buffer.from(b.dataBase64, "base64");
      if (data.byteLength > BUDGET.maxBlobBytes) {
        return { outcome: "budget-exhausted", code: "GEL-BUDGET-BLOB", message: `blob ${b.id} 超过单块预算`, position: `$.blobs[${i}]` };
      }
      if (sha256Hex(data) !== b.sha256) {
        return { outcome: "format-corrupt", code: "GEL-FORMAT-BLOB-HASH", message: `blob ${b.id} 的 sha256 校验失败`, position: `$.blobs[${i}].sha256` };
      }
      blobIds.add(b.id);
    }
    for (let i = 0; i < bundle.materials.length; i++) {
      const m = bundle.materials[i]!;
      if (m.kind === "image" && !blobIds.has(m.blobId)) {
        return { outcome: "semantic-unsolvable", code: "GEL-SEMANTIC-BLOB-REF", message: `图像材料 ${m.id} 引用了导出包中不存在的 blob ${m.blobId}`, position: `$.materials[${i}].blobId` };
      }
    }
    const seqs = bundle.events.map((e) => e.projectSeq);
    for (let i = 0; i < seqs.length; i++) {
      if (seqs[i] !== i + 1) {
        return { outcome: "format-corrupt", code: "GEL-FORMAT-SEQ", message: `事件序号不连续：第 ${i + 1} 个事件的 projectSeq=${seqs[i]}`, position: `$.events[${i}].projectSeq` };
      }
    }

    const projectId = bundle.project.id;
    if (this.projectExists(projectId)) {
      return { outcome: "ok", code: "GEL-IMPORT-IDEMPOTENT", message: "项目已存在，身份与历史保持不变（幂等导入）", position: null, projectId };
    }

    const sessionId = contentId("imp", { projectId, digest: bundle.digest });
    this.db.prepare("INSERT OR REPLACE INTO import_sessions (id, project_id, state, payload, created_at) VALUES (?, ?, 'staging', ?, ?)").run(
      sessionId, projectId, JSON.stringify({ digest: bundle.digest }), new Date().toISOString()
    );
    try {
      const tx = this.db.transaction(() => {
        this.db.prepare("INSERT INTO projects (id, name, created_at, base_params) VALUES (?, ?, ?, ?)").run(
          projectId, bundle.project.name, bundle.project.createdAt, JSON.stringify(bundle.project.baseParams)
        );
        for (const b of bundle.blobs) {
          this.db.prepare("INSERT OR IGNORE INTO blobs (id, sha256, media_type, data) VALUES (?, ?, ?, ?)").run(b.id, b.sha256, b.mediaType, Buffer.from(b.dataBase64, "base64"));
        }
        for (const m of bundle.materials) {
          this.db.prepare("INSERT OR IGNORE INTO materials (project_id, id, kind, payload) VALUES (?, ?, ?, ?)").run(projectId, m.id, m.kind, canonicalJson(m));
        }
        for (const e of bundle.events) {
          const { projectSeq, ...evt } = e;
          this.db.prepare("INSERT INTO events (project_id, seq, id, branch, parent_event_id, kind, payload) VALUES (?, ?, ?, ?, ?, ?, ?)").run(
            projectId, projectSeq, evt.id, evt.branch, evt.parentEventId, evt.kind, canonicalJson(evt)
          );
        }
        for (const br of bundle.branches) {
          this.db.prepare("INSERT OR REPLACE INTO branches (project_id, name, head_event_id) VALUES (?, ?, ?)").run(projectId, br.name, br.headEventId);
        }
        this.db.prepare("UPDATE import_sessions SET state = 'committed' WHERE id = ?").run(sessionId);
      });
      tx();
    } catch (err) {
      this.db.prepare("DELETE FROM import_sessions WHERE id = ?").run(sessionId);
      this.deleteProject(projectId);
      const msg = err instanceof Error ? err.message : String(err);
      return { outcome: "format-corrupt", code: "GEL-FORMAT-WRITE", message: `导入写入失败：${msg}`, position: "$" };
    }
    this.db.prepare("DELETE FROM import_sessions WHERE id = ?").run(sessionId);
    return { outcome: "ok", code: "GEL-IMPORT-OK", message: "导入完成，身份、顺序与来源关系保持", position: null, projectId };
  }
}

export const EVIDENCE_BASIS: Record<string, string> = {
  "GEL-SMILE-001": "弯曲泳道使同一画面高度对应不同弧长迁移，局部标尺必须按泳道分别解释",
  "GEL-RULER-002": "局部标尺仅在 ladder 锚点覆盖的弧长区间内有效，区间外不推断",
  "GEL-SAT-003": "饱和条带峰顶被削平，中心位置不可靠，只能给区间",
  "GEL-TAIL-004": "拖尾使轮廓不对称，分子量只能作为候选",
  "GEL-OVERLAP-005": "重叠双峰未解卷积，保留组内全部候选",
  "GEL-LADDER-MISSING-006": "ladder 缺带导致跨接区间，插值降级为候选且不确定度扩大",
  "GEL-RULER-NONMONO-007": "非单调标尺段不存在唯一分子量，保留全部合法候选",
  "GEL-REVISION-LOCAL-008": "修订仅使依赖该来源的派生失效，其余派生保持身份不变",
  "GEL-RULER-OUTRANGE-009": "有效区域外且未启用外推，不产生分子量",
  "GEL-ROTATION-010": "旋转帧派生保留原图与变换来源",
  "GEL-QTY-011": "无法转换的值保留原始表示并附诊断，不以默认值伪装"
};
