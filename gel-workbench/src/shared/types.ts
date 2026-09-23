/**
 * 领域模型 —— 胶道标尺：电泳条带、泳道弯曲与分子量校准工作台
 *
 * 分层原则：
 *  - material 层（不可变材料）：原图像素、拍摄方向、曝光、ladder 标称值、
 *    lane 边界、条带中心。每一项都携带像素级/仪器级来源（provenance）。
 *  - decision 层（可修改决定）：参数版本、人工接受/否定/冲突，事件溯源。
 *  - derived 层（派生结果）：检测候选、校准标尺、分子量推断；记录输入摘要、
 *    参数版本与父级依赖，永远不就地覆盖历史。
 */

// ---------- 单位 / 坐标基准 ----------
export type Unit =
  | "px" // 像素（必须带 frame）
  | "bp" // 碱基对（DNA ladder 标称分子量）
  | "kDa" // 蛋白分子量
  | "intensity" // 无量纲灰度/强度（0..1 归一）
  | "ms"; // 曝光时间单位
export type CoordFrame = "raw_image" | "upright";

export interface QValue {
  /** 数值；无法转换时保留原始表示 originalText，value 缺失并带 diagnostic */
  value?: number;
  unit: Unit;
  /** 导入时的原始表示（字符串），规范化只发生在派生层 */
  originalText?: string;
  /** 坐标基准（仅 px 类需要） */
  frame?: CoordFrame;
}

export interface Point {
  x: QValue;
  y: QValue;
}

// ---------- 诊断（带位置）----------
export type Severity = "error" | "warning" | "info";
export type OutcomeKind =
  | "ok"
  | "budget_exhausted" // 资源预算耗尽（与损坏/无解严格区分）
  | "format_corrupt" // 格式损坏
  | "semantic_unsolvable"; // 语义无解（如非单调标尺）

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  /** 带位置：对象身份 / 像素坐标 / 字段路径 */
  location?: {
    objectId?: string;
    fieldPath?: string;
    at?: Point;
    segmentId?: string;
  };
}

// ---------- 不可变材料 ----------
export type MaterialKind =
  | "raw_image"
  | "capture"
  | "ladder_nominal"
  | "lane_geometry"
  | "band_marks";

/** 稳定身份：材料内容寻址 id；同一字节/同一几何得到同一 id 与同一顺序 */
export interface MaterialBase {
  id: string;
  kind: MaterialKind;
  createdAt: string;
  /** 像素级来源描述（工具/人员、坐标基准、引用片段） */
  provenance: {
    source: "imported" | "manual" | "synthetic_case_pack" | "derived_evidence";
    author?: string;
    note?: string;
    /** 该材料直接来源的字节范围/字段路径（原图内片段） */
    inputSlice?: { offset: number; length: number; sha256: string };
  };
}

export interface RawImageMaterial extends MaterialBase {
  kind: "raw_image";
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  /** PNG 字节（合成案例为真实可解码 PNG） */
  pngBytes: Uint8Array;
  pixelSha256: string;
}

export interface CaptureMaterial extends MaterialBase {
  kind: "capture";
  rawImageId: string;
  /** 拍摄方向：将原图转正所需的顺时针旋转角（度，0/90/180/270） */
  orientationDeg: 0 | 90 | 180 | 270;
  /** 曝光：数值 + 单位（ms），原始表示保留 */
  exposure: QValue;
  flippedHorizontally: boolean;
}

export interface LadderBandNominal {
  /** 标称条带在标准中的稳定名（如 "100bp"） */
  label: string;
  molecularWeight: QValue;
}

export interface LadderNominalMaterial extends MaterialBase {
  kind: "ladder_nominal";
  catalogName: string;
  bands: LadderBandNominal[];
}

/** lane 边界：每条 lane 由两条边界折线（left/right）夹出，中心线随之派生 */
export interface Polyline {
  /** 采样点（raw_image 帧，像素级来源） */
  points: Point[];
  frame: CoordFrame;
}

export interface LaneGeometryMaterial extends MaterialBase {
  kind: "lane_geometry";
  lanes: {
    laneId: string;
    role: "sample" | "ladder";
    left: Polyline;
    right: Polyline;
  }[];
}

/** 条带中心：像素级来源 + 候选/人工来源区分 */
export type BandMarkStatus =
  | "candidate" // 自动候选
  | "accepted" // 人工接受
  | "rejected" // 人工否定
  | "ambiguous" // 重叠/饱和/拖尾：无法唯一决定，保留全部合法候选
  | "interval"; // 只能给区间

export interface BandMark {
  bandId: string;
  laneId: string;
  /** 条带中心（raw_image 帧 px）—— 像素级来源 */
  center: Point;
  /** 拖尾/饱和时的支撑轮廓区间（raw_image 帧 px，沿 lane 迁移方向） */
  support?: { from: Point; to: Point };
  status: BandMarkStatus;
  saturated?: boolean;
  smear?: boolean;
  overlapGroupId?: string;
  /** 候选时保留检测评分；人工修订保留决定事件引用 */
  score?: number;
  decidedByEventId?: string;
}

export interface BandMarksMaterial extends MaterialBase {
  kind: "band_marks";
  bands: BandMark[];
}

export type Material =
  | RawImageMaterial
  | CaptureMaterial
  | LadderNominalMaterial
  | LaneGeometryMaterial
  | BandMarksMaterial;

// ---------- 决定层（事件溯源）----------
export type ParamsVersion = {
  paramVersion: string; // 规则/参数版本
  rules: {
    peakProminence: number; // 0..1
    minBandGapPx: number;
    saturationThreshold: number; // 0..1 强度
    overlapBandGapPx: number;
    maxInterpolationGap: number; // 允许插值的最大 ladder 缺带跨度（bp）
  };
};

export type EventType =
  | "project_created"
  | "material_committed" // 提交一份（新版本）不可变材料
  | "auto_detection_run" // 运行自动检测（带预算）
  | "params_revised" // 参数修订（新版本）
  | "source_patched" // 只改动一个直接来源（局部依赖）
  | "decision_accept" // 接受条带/推断
  | "decision_reject" // 否定
  | "decision_conflict" // 互相冲突的人工决定：两个候选都保留
  | "branch_checkout"; // 回到旧事件，恢复当时依赖版本

export interface Event {
  id: string;
  seq: number;
  branch: string; // 分支名（主线 main）
  parentEventId: string | null;
  type: EventType;
  at: string;
  author: string;
  /** 输入摘要（内容寻址哈希集合） */
  inputSummary: Record<string, string>;
  /** 本次决定引用/新增的材料 */
  materialIds: string[];
  paramsVersion?: string;
  /** 当次派生结果快照的存储键（decision 历史不被最新结果覆盖） */
  derivedSnapshotKey?: string;
  payload?: Record<string, unknown>;
}

// ---------- 派生层 ----------
export interface FittingResidual {
  ladderBandId: string;
  observedMigrationPx: number;
  predictedMigrationPx: number;
  residualPx: number;
  unit: "px";
}

/** 局部标尺的一条插值段：必须携带有效区域 */
export interface CalibrationSegment {
  segmentId: string;
  scaleId: string;
  laneId: string;
  /** 有效区域：沿该 lane 中心线的迁移坐标区间（px, upright 帧） */
  validRegion: { fromPx: number; toPx: number };
  fromBandId: string;
  toBandId: string;
  fromMWbp: number;
  toMWbp: number;
  /** 段内 log10(MW) ~ migration 的线性系数 */
  slope: number;
  intercept: number;
  /** 该段的父级依赖：材料 id + 参数版本 + 上游段 */
  dependencies: string[];
  /** 缺带插值：跨度过大或被局部源改动置为陈旧时失效 */
  state: "valid" | "stale" | "invalid";
  invalidReason?: string;
}

export interface CalibrationScale {
  scaleId: string;
  ladderLaneId: string;
  ladderNominalId: string;
  segments: CalibrationSegment[];
  residuals: FittingResidual[];
  status: "ok" | "non_monotonic" | "insufficient_bands";
  diagnostics: Diagnostic[];
  /** 输入摘要 + 参数版本 + 父级依赖 */
  inputSummary: Record<string, string>;
  paramsVersion: string;
  parents: string[];
}

export type InferenceStatus =
  | "estimated" // 唯一点估计
  | "candidate_set" // 重叠：全部合法候选
  | "interval" // 饱和/拖尾：只能给区间
  | "out_of_range" // 超出 ladder 范围
  | "non_monotonic_scale"
  | "stale" // 局部标尺失效（修订后局部失效）
  | "missing_ladder_band"
  | "rejected";

export interface MWInference {
  inferenceId: string;
  bandId: string;
  laneId: string;
  /** 沿 lane 中心线的迁移坐标（px, upright 帧），带基准 */
  migration: QValue;
  /** 使用的插值段（点击分子量可回到 ladder 点与插值段） */
  segmentId?: string;
  scaleId?: string;
  pointBp?: number;
  candidatesBp?: number[];
  intervalBp?: { low: number; high: number };
  status: InferenceStatus;
  invalidReason?: string;
  /** 有效区间（该局部标尺覆盖的迁移范围） */
  validRegion?: { fromPx: number; toPx: number };
  provenanceEventId: string;
  dependencies: string[];
}

export interface DerivedSnapshot {
  key: string;
  paramsVersion: string;
  inputSummary: Record<string, string>;
  parents: string[];
  scales: CalibrationScale[];
  inferences: MWInference[];
  diagnostics: Diagnostic[];
  outcome: OutcomeKind;
  budgetUsed: number;
  budgetLimit: number;
}

// ---------- 项目 / 导出 ----------
export interface Project {
  id: string;
  name: string;
  createdAt: string;
  headEventIdByBranch: Record<string, string>;
}

export interface ExportBundle {
  format: "gel-workbench-bundle";
  formatVersion: 1;
  project: { id: string; name: string; createdAt: string };
  branches: string[];
  events: Event[];
  materials: SerializedMaterial[];
  snapshots: { key: string; snapshot: Omit<DerivedSnapshot, "scales" | "inferences"> & {
    scales: unknown[];
    inferences: unknown[];
  } }[];
  checksumSha256: string;
}

export type SerializedMaterial = Material & { pngBytes?: undefined } & {
  pngBase64?: string;
};
