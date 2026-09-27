// 领域类型：所有领域量携带单位/坐标基准；原始表示与派生规范化分层。
// 该模块不含浏览器 API，可被 Node 测试直接调用。

export type Unit = 'bp' | 'kDa' | 'pixel' | 'gray' | 'deg' | 'ratio' | 'ms' | 'none';

export type FrameKind = 'raw-image' | 'display' | 'lane-local';

/** 坐标基准：任何点/值都声明其相对的帧与单位，避免“同一高度”误读。 */
export interface CoordRef {
  frameId: string;
  frameKind: FrameKind;
  axis?: 'x' | 'y' | 's' | 'mw';
  unit: Unit;
}

/** 带基准的点。x/y 永远保留原始像素表示（pixel）。 */
export interface PixelPoint {
  x: number;
  y: number;
  ref: CoordRef;
}

/** 带单位的领域量；raw 是原始表示字符串，value 是规范化后的数值（可能缺失）。 */
export interface DomainValue {
  value: number | null;
  unit: Unit;
  raw: string;
  ref?: CoordRef;
  diagnostic?: Diagnostic;
}

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code:
    | 'INCOMPLETE_INPUT'
    | 'UNCONVERTIBLE_VALUE'
    | 'RESOURCE_BUDGET_EXHAUSTED'
    | 'FORMAT_CORRUPT'
    | 'SEMANTIC_UNRESOLVABLE'
    | 'LADDER_MISSING_BAND'
    | 'SATURATED_BAND'
    | 'OVERLAPPING_BANDS'
    | 'SMEARED_BAND'
    | 'NON_MONOTONIC_SCALE'
    | 'RULER_OUTSIDE_VALID_REGION'
    | 'LOCAL_RULER_INVALIDATED'
    | 'CONFLICTING_DECISIONS'
    | 'ORIENTATION_MISMATCH'
    | 'STALE_RESULT';
  severity: Severity;
  message: string;
  /** 带位置的诊断：指向具体材料/坐标。 */
  location?: { materialId: string; point?: PixelPoint; field?: string };
}

// ---------- 材料（不可变层；改动产生新版本，不覆盖） ----------

export interface ImageChannelStats {
  min: number;
  max: number;
  saturatedPixelFraction: number;
  histogram: number[]; // 32 bins
  exposureClass: 'underexposed' | 'normal' | 'overexposed';
}

export interface GelImageMaterial {
  kind: 'gel-image';
  id: string;
  version: number;
  parentVersionId: string | null;
  filename: string;
  width: number;
  height: number;
  grayscale: Uint8Array | number[];
  /** 拍摄方向：原始记录的角度（deg，顺时针），原图本身不被旋转修改。 */
  recordedOrientationDeg: DomainValue;
  /** 曝光：原始表示 + 派生通道统计。 */
  exposure: { rawNote: string; stats: ImageChannelStats | null };
  sha256: string;
  createdAt: string;
}

export interface LadderBand {
  /** 标称分子量，原始表示保留（如 "1,500 bp"）。 */
  nominal: DomainValue;
  /** 声明的迁移位置（raw 帧像素）；允许缺失，交给检测。 */
  expectedPoint: PixelPoint | null;
  observed: boolean; // 在原图中是否可见（缺带检测）
}

export interface LadderMaterial {
  kind: 'ladder-spec';
  id: string;
  version: number;
  parentVersionId: string | null;
  laneId: string;
  vendorName: string;
  unit: Unit;
  bands: LadderBand[];
  createdAt: string;
}

/** lane 中心曲线：以像素折线表示“弯曲泳道”，边界宽度像素。 */
export interface LaneSketchMaterial {
  kind: 'lane-sketch';
  id: string;
  version: number;
  parentVersionId: string | null;
  imageId: string;
  centerline: PixelPoint[];
  halfWidthPx: number;
  /** 迁移方向：沿曲线弧长 s，s=0 为加样孔。 */
  migrationDirection: 'top-to-bottom' | 'bottom-to-top' | 'left-to-right' | 'right-to-left';
  isLadderLane: boolean;
  createdAt: string;
}

export interface BandObservationMaterial {
  kind: 'band-observation';
  id: string;
  version: number;
  parentVersionId: string | null;
  imageId: string;
  laneId: string;
  /** 条带中心像素级来源。 */
  center: PixelPoint;
  widthPx: number;
  /** 沿 lane 中心曲线的弧长位置（派生层计算，缺失时附诊断）。 */
  arcLength: DomainValue | null;
  peakIntensity: DomainValue;
  saturated: boolean;
  smeared: boolean;
  overlapGroupId: string | null;
  createdAt: string;
}

export type Material =
  | GelImageMaterial
  | LadderMaterial
  | LaneSketchMaterial
  | BandObservationMaterial;

// ---------- 事件 / 决定（可修改决定层，只追加） ----------

export type ParameterName =
  | 'orientation-deg'
  | 'calibration-model'
  | 'saturation-threshold'
  | 'overlap-merge-gap-px'
  | 'ruler-valid-padding';

export interface EventBase {
  id: string;
  seq: number; // 项目内全局顺序（等价输入得到稳定顺序）
  projectId: string;
  branch: string;
  parentEventId: string | null; // 同一分支上的父事件（分支/决定历史）
  timestamp: string;
  actor: 'auto' | `human:${string}`;
}

export interface MaterialIngestedEvent extends EventBase {
  type: 'material-ingested';
  material: Material;
}

export interface ParameterRevisionEvent extends EventBase {
  type: 'parameter-revision';
  name: ParameterName;
  oldValue: unknown;
  newValue: unknown;
  reason: string;
}

export interface DecisionEvent extends EventBase {
  type: 'decision';
  targetCandidateId: string;
  action: 'accept' | 'reject' | 'set-range' | 'choose-candidate' | 'conflict';
  payload?: { lower?: number; upper?: number; chosenCandidateId?: string; note?: string };
}

export interface BranchCreatedEvent extends EventBase {
  type: 'branch-created';
  branch: string;
  fromBranch: string;
  reason: string;
}

/** 计算结果也作为事件记录，携带输入摘要、参数版本、父级依赖，保证可重放。 */
export interface ComputedEvent extends EventBase {
  type: 'computed';
  computation: string; // e.g. 'calibrate-ladder' | 'infer-molecular-weight'
  inputSummary: string; // 规范化输入内容的 sha256 摘要
  parameterVersion: number;
  parents: string[]; // 依赖的事件 id
  result: ComputedResult;
}

export type ProjectEvent =
  | MaterialIngestedEvent
  | ParameterRevisionEvent
  | DecisionEvent
  | BranchCreatedEvent
  | ComputedEvent;

// ---------- 计算结果 ----------

export type CandidateStatus =
  | 'confirmed'
  | 'candidate'
  | 'range'
  | 'rejected'
  | 'invalid'
  | 'conflicted';

export interface LadderPointResult {
  ladderBandId: string; // 稳定身份
  nominal: DomainValue;
  matchedBandId: string | null;
  point: PixelPoint;
  arcLength: number;
  residual: number | null; // 拟合残差（迁移像素单位）
  used: boolean;
  diagnostic?: Diagnostic;
}

export interface CalibrationSegment {
  id: string;
  fromLadderBandId: string;
  toLadderBandId: string;
  /** 有效迁移弧长区间 [sLow, sHigh]，超出即失效。 */
  validS: [number, number];
  model: 'linear-log';
  slope: number;
  intercept: number;
}

export interface CalibrationResult {
  laneId: string;
  model: 'piecewise-linear-log';
  points: LadderPointResult[];
  segments: CalibrationSegment[];
  /** 整条 lane 的有效区域；微笑弯曲按 lane 局部，不允许跨 lane 同高度推断。 */
  validRegion: { laneId: string; s: [number, number]; note: string };
  monotonic: boolean;
  diagnostics: Diagnostic[];
}

export interface MwCandidate {
  id: string; // 稳定身份
  bandId: string;
  status: CandidateStatus;
  mw: DomainValue | null;
  segmentId: string | null;
  ladderPointIds: string[];
  /** 无法唯一决定时保留的全部合法候选（如重叠/饱和）。 */
  alternatives: { mw: DomainValue; segmentId: string | null; ladderPointIds: string[] }[];
  range: { lower: DomainValue; upper: DomainValue } | null;
  diagnostics: Diagnostic[];
  decidedBy: string[] | null;
  stale?: boolean;
}

export interface InferenceResult {
  laneId: string;
  candidates: MwCandidate[];
  diagnostics: Diagnostic[];
}

export interface ComputedResult {
  calibration?: CalibrationResult;
  inference?: InferenceResult;
}

// ---------- 聚合投影 ----------

export interface ProjectState {
  projectId: string;
  mainBranch: string;
  branches: string[];
  materials: Material[]; // 每个逻辑 id 的最新版本（含历史版本另存）
  materialHistory: Record<string, Material[]>;
  events: ProjectEvent[]; // 全分支全量，按 seq
  branchHeads: Record<string, string | null>;
  parameterVersions: { name: ParameterName; version: number; value: unknown }[];
  computations: Record<string, ComputedResult>; // computation key -> 最新
}

export interface Outcome<T> {
  ok: boolean;
  value?: T;
  diagnostics: Diagnostic[];
}
