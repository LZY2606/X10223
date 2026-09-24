/** 事件溯源：所有决定与计算都是事件；回到任意旧事件可恢复当时的依赖版本与可见结论。
 *  归约器是纯函数，服务端与测试直接调用，不藏在浏览器里。 */
import type {
  BandCenter, Diagnostic, LaneBoundary, LadderNominal, MwEstimate, Quantity,
} from "./types";
import { eventId, stableSort } from "./ids";

export type EventType =
  | "material.imported"        // 不可变材料登记（原图/方向/曝光/标称值/边界/条带中心）
  | "detection.completed"      // 自动候选产生
  | "calibration.computed"     // 标尺与分子量计算（记录输入摘要、参数版本、父级依赖）
  | "decision.made"            // 人工决定：接受/否定/修订/参数调整
  | "params.revised"           // 参数修订（新版本）
  | "diagnostic.raised";       // 机器可读诊断事件

export interface GelEvent {
  id: string;
  seq: number;                 // 全局单调序号（导入时保留）
  projectId: string;
  branch: string;              // 分支（默认 main）
  parentEventId: string | null;
  type: EventType;
  /** 事件载荷（见各 Payload 类型） */
  payload: Record<string, unknown>;
  /** 父级依赖：本事件依赖的材料/事件 ID */
  dependsOn: string[];
  /** 参数版本 */
  paramsVersion: string;
  createdAt: string;           // 时间基准 ISO8601
}

export interface MaterialPayload {
  materialId: string;
  kind: "image-raw" | "capture-orientation" | "exposure" | "ladder-nominal"
      | "lane-boundary" | "band-center" | "image-derotated" | "gel-metadata";
  /** 不可变内容（像素级来源） */
  content: unknown;
  contentHash: string;
  /** 原始表示（未规范化） */
  raw?: string;
}

export interface DetectionPayload {
  imageMaterialId: string;
  lanes: LaneBoundary[];
  bands: BandCenter[];
  diagnostics: Diagnostic[];
}

export interface CalibrationPayload {
  rulerLane: number;
  validLanes: [number, number];
  validY: [number, number];
  anchors: { yPx: number; sizeRaw: string }[];
  estimates: { bandKey: string; laneIndex: number; yPx: number; estimate: MwEstimate }[];
  residuals: { yPx: number; sizeRaw: string; residualLog: number }[];
  diagnostics: Diagnostic[];
  /** 输入摘要 */
  inputDigest: string;
}

export interface DecisionPayload {
  action: "accept" | "reject" | "revise-band" | "revise-ladder" | "adjust-params";
  target: string;              // bandKey / ladder bandIndex / param 名
  detail: unknown;
  rationale: string;
}

export interface DiagnosticPayload {
  kind: "budget-exhausted" | "format-corrupt" | "semantic-unsolvable";
  diagnostics: Diagnostic[];
}

export function makeEvent(
  projectId: string,
  branch: string,
  parentEventId: string | null,
  type: EventType,
  payload: Record<string, unknown>,
  dependsOn: string[],
  paramsVersion: string,
  seq: number,
  createdAt: string,
): GelEvent {
  const id = eventId({ projectId, branch, parentEventId, type, payload, dependsOn, paramsVersion, seq });
  return { id, seq, projectId, branch, parentEventId, type, payload, dependsOn, paramsVersion, createdAt };
}

/** 归约出的审阅状态 */
export interface ReviewState {
  materials: Map<string, MaterialPayload>;
  lanes: LaneBoundary[];
  bands: BandCenter[];                    // 含人工修订后的状态
  ladderNominals: LadderNominal[];
  calibration: CalibrationPayload | null;
  decisions: { event: GelEvent; payload: DecisionPayload }[];
  diagnostics: Diagnostic[];
  paramsVersion: string;
  /** 事件可见性：截至 asOfSeq（含） */
  asOfSeq: number;
}

export const bandKey = (b: BandCenter): string =>
  `L${b.laneIndex}@y${b.center.y.toFixed(1)}`;

/** 归约：重放到 asOfSeq（含）。等价输入得到稳定顺序（按 seq，再按 id）。 */
export function reduceEvents(events: GelEvent[], asOfSeq?: number): ReviewState {
  const sorted = stableSort(events, (e) => `${String(e.seq).padStart(12, "0")}:${e.id}`);
  const state: ReviewState = {
    materials: new Map(),
    lanes: [],
    bands: [],
    ladderNominals: [],
    calibration: null,
    decisions: [],
    diagnostics: [],
    paramsVersion: "v0",
    asOfSeq: asOfSeq ?? Number.MAX_SAFE_INTEGER,
  };
  for (const e of sorted) {
    if (e.seq > state.asOfSeq) continue;
    switch (e.type) {
      case "material.imported": {
        const p = e.payload as unknown as MaterialPayload;
        state.materials.set(p.materialId, p);
        if (p.kind === "ladder-nominal") {
          state.ladderNominals = (p.content as { nominals: LadderNominal[] }).nominals;
        }
        break;
      }
      case "detection.completed": {
        const p = e.payload as unknown as DetectionPayload;
        state.lanes = p.lanes;
        state.bands = p.bands;
        state.diagnostics.push(...p.diagnostics);
        break;
      }
      case "calibration.computed": {
        state.calibration = e.payload as unknown as CalibrationPayload;
        state.diagnostics.push(...state.calibration.diagnostics);
        break;
      }
      case "decision.made": {
        const p = e.payload as unknown as DecisionPayload;
        state.decisions.push({ event: e, payload: p });
        if (p.action === "accept" || p.action === "reject") {
          const status = p.action === "accept" ? "accepted" : "rejected";
          state.bands = state.bands.map((b) =>
            bandKey(b) === p.target ? { ...b, status: status as BandCenter["status"] } : b);
        } else if (p.action === "revise-band") {
          const d = p.detail as { band: BandCenter };
          state.bands = state.bands.map((b) =>
            bandKey(b) === p.target ? { ...d.band, status: "revised" as const } : b);
        } else if (p.action === "revise-ladder") {
          const d = p.detail as { nominals: LadderNominal[] };
          state.ladderNominals = d.nominals;
        }
        break;
      }
      case "params.revised": {
        state.paramsVersion = (e.payload as { version: string }).version;
        break;
      }
      case "diagnostic.raised": {
        state.diagnostics.push(...(e.payload as unknown as DiagnosticPayload).diagnostics);
        break;
      }
    }
  }
  return state;
}

/** 局部失效：给定一个源数据改动事件，计算受影响的下游事件 ID 集合 */
export function affectedBy(events: GelEvent[], changedIds: string[]): Set<string> {
  const affected = new Set<string>(changedIds);
  let grew = true;
  const sorted = stableSort(events, (e) => `${String(e.seq).padStart(12, "0")}:${e.id}`);
  while (grew) {
    grew = false;
    for (const e of sorted) {
      if (affected.has(e.id)) continue;
      if (e.dependsOn.some((d) => affected.has(d))) {
        affected.add(e.id);
        grew = true;
      }
    }
  }
  return affected;
}
