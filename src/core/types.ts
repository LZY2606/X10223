// 领域核心类型：不可变材料 / 可修改决定 / 派生证据 三层
// 所有领域量携带单位或坐标基准；像素级来源一律保留原始(raw)帧坐标。

export interface Point {
  x: number;
  y: number;
}

/** raw = 原始照片像素坐标（左上原点，x 向右，y 向下）；canonical = 按拍摄方向旋转后，泳道自上而下 */
export type CoordFrame = "raw" | "canonical";

/** 把原始照片顺时针旋转多少度后，泳道迁移方向自上而下 */
export type Rotation = 0 | 90 | 180 | 270;

export type MWUnit = "bp" | "kDa";

export type Outcome = "ok" | "budget" | "corrupt" | "incoherent";

export type SourceKind = "auto" | "manual" | "import";

/** 像素级来源：任何 lane 边界点、band 中心都能回溯到它 */
export interface SourceRef {
  kind: SourceKind;
  actor: string;
  at: string;
  file?: string;
  /** 原始帧整数像素位置 */
  pixel?: Point;
  /** 原始帧像素窗口 */
  window?: { x0: number; y0: number; x1: number; y1: number };
  note?: string;
}

export interface ExposureSpec {
  /** 曝光时长 ms；为 null 表示来源材料缺失，绝不伪造默认值 */
  exposureMs: number | null;
  gain: number | null;
  source: SourceRef;
  rawText: string;
}

export interface ImageMaterial {
  id: string;
  revisionId: string;
  width: number;
  height: number;
  rotation: Rotation | null;
  exposure: ExposureSpec;
  sha256: string;
  blobId: string;
  source: SourceRef;
}

export interface LaneSpec {
  id: string;
  name: string;
  role: "ladder" | "sample";
  /** raw 帧折线，泳道中心线，整数像素 */
  curve: Point[];
  /** 泳道半宽（像素） */
  halfWidthPx: number;
  source: SourceRef;
}

export interface LaneMaterial {
  id: string;
  revisionId: string;
  imageId: string;
  lanes: LaneSpec[];
  source: SourceRef;
}

export interface NominalRung {
  id: string;
  label: string;
  /** 导入时的原始表示，保留不丢弃 */
  raw: string;
  mw: number | null;
  unit: MWUnit | null;
  diagnostic?: Diagnostic;
}

export interface LadderNominalMaterial {
  id: string;
  revisionId: string;
  ladderLaneId: string;
  declaredUnitRaw: string;
  declaredUnit: MWUnit | null;
  rungs: NominalRung[];
  source: SourceRef;
}

export type BandFlag = "saturated" | "smeared" | "overlap";

export interface BandSpec {
  id: string;
  laneId: string;
  /** raw 帧整数像素中心 */
  center: Point;
  /** 饱和等情况下中心无法唯一决定时的合法区间端点（raw 帧） */
  centerCandidates?: Point[];
  /** 条带轮廓多边形（raw 帧像素） */
  contour: Point[];
  /** 沿泳道采样的灰度轮廓（索引=canonical 弧长像素） */
  profile: number[];
  profileStartS: number;
  widthPx: number;
  peakValue: number;
  plateauPx: number;
  flags: BandFlag[];
  overlapGroupId?: string;
  source: SourceRef;
}

export interface BandMaterial {
  id: string;
  revisionId: string;
  imageId: string;
  bands: BandSpec[];
  source: SourceRef;
}

export type MaterialType = "image" | "lanes" | "ladder" | "bands";

export interface Materials {
  images: Record<string, ImageMaterial>;
  laneSets: Record<string, LaneMaterial>;
  ladders: Record<string, LadderNominalMaterial>;
  bandSets: Record<string, BandMaterial>;
  blobs: Record<string, Uint8Array>;
}

// ---------- 诊断 ----------

export type DiagCode =
  | "ORIENTATION_UNSET"
  | "NOMINAL_UNPARSEABLE"
  | "NOMINAL_UNIT_MISSING"
  | "LADDER_RUNG_MISSING"
  | "CALIBRATION_NON_MONOTONIC"
  | "BAND_SATURATED"
  | "BAND_SMEARED"
  | "BANDS_OVERLAP"
  | "OUTSIDE_VALID_REGION"
  | "LANE_CURVE_DEGENERATE"
  | "BUDGET_EXHAUSTED"
  | "REVISION_LOCAL_INVALIDATION"
  | "EXPOSURE_MISSING";

export interface Diagnostic {
  code: DiagCode;
  severity: "error" | "warning" | "info";
  message: string;
  /** 带位置的诊断：raw 帧像素 / 弧长 / 行号 */
  position?: {
    frame?: CoordFrame;
    pixel?: Point;
    sPx?: number;
    laneId?: string;
    bandId?: string;
    rungId?: string;
    segmentId?: string;
    nominalRow?: number;
  };
  subjectIds: string[];
}

// ---------- 事件溯源 ----------

export type EventKind =
  | "project.created"
  | "material.imported"
  | "material.revised"
  | "decision.laneEdited"
  | "decision.bandEdited"
  | "decision.candidateAccepted"
  | "decision.candidateRejected"
  | "decision.calibrationParams"
  | "decision.rungState"
  | "decision.conflictResolved";

export interface CalibrationParamsV1 {
  paramVersion: string;
  model: "log-linear-piecewise";
  /** 饱和判定：连续达到峰值像素数阈值 */
  saturationPlateauPx: number;
  /** 拖尾判定：不对称比阈值 */
  smearAsymmetry: number;
  /** 重叠判定：同泳道两峰中心弧长距离阈值（px） */
  overlapPx: number;
  /** 残差报告使用的全局 log-linear OLS（仅诊断，不参与局部插值） */
  residualModel: "log-linear-ols-global";
}

export type EventPayload =
  | { project: { name: string; scenario: string; narrativeStage: number } }
  | { materialType: MaterialType; materialId: string; revisionId: string }
  | {
      materialType: MaterialType;
      materialId: string;
      newRevisionId: string;
      parentRevisionId: string;
      reason: string;
    }
  | { laneSetId: string; laneId: string; curve: Point[]; reason: string }
  | { bandSetId: string; bandId: string; center: Point; reason: string }
  | { valueIds: string[]; note: string }
  | { valueIds: string[]; note: string }
  | { params: CalibrationParamsV1 }
  | { rungId: string; state: "present" | "missing"; reason: string }
  | { branch: string; decision: "accept-auto" | "manual-adjust" | "reject"; note: string };

export interface GelEvent {
  id: string;
  projectId: string;
  /** 项目内稳定顺序 */
  seq: number;
  branch: string;
  /** DAG 父事件（通常是当前分支头；冲突解决可有两个父） */
  parentIds: string[];
  ts: string;
  actor: string;
  kind: EventKind;
  payload: unknown;
}

// ---------- 派生证据 ----------

export type ValueStatus =
  | "accepted"
  | "candidate"
  | "interval"
  | "rejected"
  | "invalid";

export interface SegmentValue {
  id: string;
  kind: "segment";
  loRungId: string;
  hiRungId: string;
  /** 局部标尺有效区域，canonical 弧长（px，含单位基准） */
  validRegionSPx: [number, number] | null;
  valid: boolean;
  invalidReason?: DiagCode;
  /** 端点 log10(MW) */
  logMwLo: number | null;
  logMwHi: number | null;
  /** 全局 OLS 在该段的拟合残差（log10 MW） */
  residualLogMw: number | null;
  diagnostics: Diagnostic[];
  /** 输入摘要 + 参数版本 + 父级依赖 */
  inputSummary: string;
  paramVersion: string;
  parentDeps: string[];
  computedFromEventId: string;
}

export interface MwCandidate {
  valueId: string;
  mw: number;
  unit: MWUnit;
  segmentId: string;
  sPx: number;
}

export interface MwValue {
  id: string;
  kind: "mw";
  bandId: string;
  laneId: string;
  unit: MWUnit | null;
  /** 唯一定论时 */
  mw: number | null;
  /** 饱和/区间结论 */
  rangeMw: [number, number] | null;
  /** 无法唯一决定时的全部合法候选 */
  candidates: MwCandidate[];
  status: ValueStatus;
  invalidReason?: DiagCode;
  /** 该 band 沿自身泳道的 canonical 弧长 */
  sPx: number | null;
  /** 同一图像高度在 ladder 泳道上的弧长——微笑弯曲下二者不同 */
  ladderSPxAtSameY: number | null;
  diagnostics: Diagnostic[];
  inputSummary: string;
  paramVersion: string;
  parentDeps: string[];
  computedFromEventId: string;
}

export interface ComputedState {
  outcome: Outcome;
  segments: Record<string, SegmentValue>;
  values: Record<string, MwValue>;
  diagnostics: Diagnostic[];
  /** 消耗预算（如轮廓采样点数） */
  budgetUsed: number;
  budgetLimit: number | null;
  computedFromEventId: string;
}

export interface ProjectState {
  projectId: string;
  name: string;
  branch: string;
  atEventId: string;
  materials: Materials;
  params: CalibrationParamsV1;
  rungStates: Record<string, "present" | "missing">;
  decisions: { accepted: string[]; rejected: string[] };
  computed: ComputedState;
}
