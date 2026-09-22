// 领域模型：不可变材料（material）与可修改决定（decision event）严格分层。
// 所有领域量带单位或坐标基准；原始表示在导入层保留，派生层才规范化。

export type Unit = 'bp' | 'px' | 'mm' | 'a.u.' | 'deg' | 'ratio' | 's' | 'keV' | string;

/** 带单位/坐标基准的领域量。raw 保留原始表示；value 是规范化后的派生值。 */
export interface Q {
  value: number;
  unit: Unit;
  raw?: string;
  basis?: string; // 坐标/时间基准说明
}

export interface Point { x: number; y: number }

/** 像素级来源：任何派生几何都能回到原图坐标与材料版本。 */
export interface Provenance {
  materialId: string;
  version: number;
  frame: FrameId;
  at?: Point[];
  note?: string;
}

export type FrameId = string;

/** 坐标框架：image-px 原图像素；arc-s 沿泳道中心线弧长（像素）。 */
export interface Frame {
  id: FrameId;
  type: 'image-px' | 'arc-s' | 'nominal';
  origin: Point;
  axes: { x: string; y: string };
  basis: string;
}

export type MaterialType =
  | 'rawImage'
  | 'orientation'
  | 'exposure'
  | 'ladderNominal'
  | 'laneBoundary'
  | 'bandCenter';

export interface RawImageMaterial {
  id: string;
  type: 'rawImage';
  version: number;
  blobId: string;
  width: number;
  height: number;
  channels: number;
  bitDepth: number;
  sha256: string;
  capturedAt: string; // 时间基准
  origin: 'import' | 'derived-rotate' | 'derived-warp';
  derivedFrom?: Provenance;
}

export interface OrientationMaterial {
  id: string;
  type: 'orientation';
  version: number;
  imageId: string;
  rotationCw: Q; // 相对拍摄原始方向的顺时针角度(deg)
  flipped: boolean;
  calibrated: boolean;
  raw?: { rotation: string; flipped?: string };
}

export interface ExposureMaterial {
  id: string;
  type: 'exposure';
  version: number;
  imageId: string;
  timeS?: Q;
  gain?: Q;
  saturationLevel: number; // 像素满量程（如 255）
  saturatedPixels?: number;
  raw?: Record<string, string>;
}

export interface LadderNominalMaterial {
  id: string;
  type: 'ladderNominal';
  version: number;
  laneId: string;
  /** 标称条带分子量，按分子量降序（迁移距离升序）。raw 保留原表示。 */
  bands: { id: string; mw: Q; raw?: string; missing?: boolean }[];
  unit: Unit;
  source: string;
}

export interface LaneBoundaryMaterial {
  id: string;
  type: 'laneBoundary';
  version: number;
  imageId: string;
  laneId: string;
  label: string;
  role: 'ladder' | 'sample';
  /** 左右边界折线（image-px）。弯曲泳道即曲线折线。 */
  left: Point[];
  right: Point[];
  kind: 'straight' | 'curved';
  source: 'auto' | 'manual';
}

export interface BandCenterMaterial {
  id: string;
  type: 'bandCenter';
  version: number;
  imageId: string;
  laneId: string;
  at: Point; // image-px 像素中心
  source: 'auto' | 'manual';
  saturated?: boolean;
  smeared?: boolean;
  overlapWith?: string;
  confidence?: number;
}

export type Material =
  | RawImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderNominalMaterial
  | LaneBoundaryMaterial
  | BandCenterMaterial;

export type EventType =
  | 'import'
  | 'orientation-calibrated'
  | 'parameter-revision'
  | 'source-change'
  | 'decision-accept'
  | 'decision-reject'
  | 'decision-adjust'
  | 'scenario'
  | 'branch'
  | 'conflict';

export interface Event {
  id: string;
  seq: number;
  projectId: string;
  branch: string;
  parentEventId: string | null;
  type: EventType;
  at: string;
  actor: 'auto' | 'reviewer' | 'system';
  message: string;
  /** 该事件引入或作废的材料版本 */
  upserts?: Material[];
  retires?: string[]; // material ids retired
  params?: CalibrationParams;
  scenario?: ScenarioKind;
  /** 决定的作用目标（稳定身份），历史回放时据此恢复 */
  target?: string;
  payload?: Record<string, unknown>;
}

export interface CalibrationParams {
  paramVersion: string; // 规则版本，如 cal-v1
  model: 'piecewise-linear-log' | 'global-linear-log';
  bandSearchRadiusPx: number;
  saturationFraction: number; // 判定饱和的像素占比阈值
  overlapBandWidthRatio: number; // 两峰合并判据
  maxAssignments: number; // 缺带时合法候选枚举上限（资源预算）
  confidenceAuto: number;
}

export type ScenarioKind =
  | 'rotation'
  | 'smile-warp'
  | 'ladder-missing-band'
  | 'saturation'
  | 'overlap'
  | 'nonmonotonic-ruler'
  | 'revision-local-failure';

/** 三态失败：资源预算耗尽 / 格式损坏 / 语义无解。 */
export type FailureClass = 'BUDGET_EXHAUSTED' | 'FORMAT_CORRUPT' | 'SEMANTIC_NO_SOLUTION';

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning';
  failureClass?: FailureClass;
  message: string;
  position: {
    frame: FrameId;
    laneId?: string;
    bandId?: string;
    materialId?: string;
    point?: Point;
  };
}

export interface CalibrationSegment {
  id: string;
  fromKnot: string;
  toKnot: string;
  s0: Q;
  s1: Q;
  mw0: Q;
  mw1: Q;
  /** 有效弧长区间（局部标尺必须带有效区域） */
  validDomain: { min: Q; max: Q };
  valid: boolean;
  slopeLogPerPx: number;
  residuals: { knotId: string; observedS: Q; predictedS: Q; residualPx: number }[];
}

export interface BandResult {
  id: string;
  laneId: string;
  center: Point;
  arcS: Q;
  status: 'accepted' | 'rejected' | 'candidate' | 'interval' | 'invalid';
  /** 饱和/拖尾/重叠不得唯一化：保留全部合法候选（bp） */
  mwCandidates?: { mw: Q; segmentId: string }[];
  mwRange?: { min: Q; max: Q };
  mw?: Q;
  segmentId?: string;
  flags: string[];
  diagnostics: Diagnostic[];
  decision?: { by: string; eventId: string; at: string; note?: string };
}

export interface LaneResult {
  laneId: string;
  role: 'ladder' | 'sample';
  centerline: Point[];
  arcLengthPx: number;
  validDomain?: { min: Q; max: Q };
  segments: CalibrationSegment[];
  globalFit?: {
    intercept: number;
    slope: number;
    r2: number;
    residuals: { knotId: string; residualPx: number }[];
  };
  bands: BandResult[];
  diagnostics: Diagnostic[];
}

/** 单个事件计算出的结论。target/order 稳定；等价输入顺序一致。 */
export interface ComputeOutput {
  frames: Frame[];
  lanes: LaneResult[];
  diagnostics: Diagnostic[];
  inputDigest: string; // 输入摘要（canonical hash）
  paramsVersion: string;
  parents: string[]; // 父级依赖（事件 id）
  judgments: Judgment[]; // 机器可读取的判断依据
  affectedTargets: string[]; // 受影响对象（限定影响范围）
}

/** 机器可读取事件：把“为什么只能是候选/区间、为何局部失效”结构化。 */
export interface Judgment {
  id: string;
  rule:
    | 'smile-height-not-equal-mw'
    | 'local-ruler-requires-valid-domain'
    | 'saturated-must-be-candidate'
    | 'smear-must-be-interval'
    | 'overlap-must-be-candidate-set'
    | 'missing-band-enumerate-assignments'
    | 'nonmonotonic-ruler-rejected'
    | 'revision-local-invalidation'
    | 'candidate-set-exhausted-budget'
    | 'impact-scope-contained';
  outcome: 'hold' | 'violation' | 'info';
  targets: string[];
  evidence: Record<string, unknown>;
  basis: Provenance[];
}

export interface SnapshotView {
  eventId: string;
  event: Event;
  materials: Material[];
  output: ComputeOutput | null;
}
