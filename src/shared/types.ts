/**
 * 胶道标尺工作台 —— 共享领域类型。
 *
 * 设计分层：
 *  - ImmutableMaterial 不可变材料层（原图、拍摄方向、曝光、ladder 标称值、
 *    lane 边界、band 中心）：所有几何量均带像素坐标基准；任何“改动”产生新材料，
 *    原材料永不被覆盖。
 *  - Revision/Decision 可修改决定层（参数版本、人工接受/否定/调整、冲突）。
 *  - NodeResult 派生计算层：带输入摘要、参数版本与父级依赖，内容寻址、可重放。
 *  - Event 事件层：上述一切都以追加事件表达，分支与决定历史可回溯。
 */

export type ISODateTime = string;

/** 领域量的单位/基准标签：所有显示值必须带单位或坐标基准。 */
export type Unit =
  | 'bp'        // 碱基对（ladder / 核酸分子量）
  | 'kDa'       // 千道尔顿（蛋白分子量）
  | 'pixel'     // 像素（图像坐标，原点左上，x 向右 y 向下）
  | 'px^2'      // 积分面积
  | 'gray'      // 灰度 0..255
  | 'ms'        // 曝光毫秒
  | 'degree';   // 拍摄方向角度

/** 带单位的量；原始表示保存在 raw，派生层才规范化。 */
export interface Quantity {
  value: number;
  unit: Unit;
  /** 导入时的原始文本/表示；无法转换时保留并附诊断。 */
  raw?: string;
}

/** 像素坐标系中的点。coordinateSystem 标明基准（原图/旋转校正后）。 */
export interface PixelPoint {
  x: number;
  y: number;
  unit: 'pixel';
  coordinateSystem: string; // 例如 "original-image:IMG#v1" / "corrected:ROT#..."
}

/** 泳道中心线（允许弯曲：“微笑”时用折线/曲线参数表达）。 */
export interface LaneCurve {
  /** 折线采样点，单位像素，沿迁移方向自 wells 到底端。 */
  points: PixelPoint[];
  /** 泳道横向半宽（像素），随弧长可变。 */
  halfWidth: number;
  kind: 'straight' | 'smile';
  /** 当 kind=smile 时记录曲率，便于重放。 */
  curvature?: number;
}

/** 不可变材料。 */
export type MaterialType =
  | 'raw-image'
  | 'orientation'
  | 'exposure'
  | 'ladder-nominals'
  | 'lane-boundaries'
  | 'band-centers';

export interface RawImageMaterial {
  id: string;
  type: 'raw-image';
  width: number;
  height: number;
  channels: 1;
  /** 每像素 0..255 灰度，行优先、base64(PNG 无关的原始字节) 存储，保留像素级来源。 */
  grayBase64: string;
  bitDepth: 8;
  capturedAt: ISODateTime;
  /** 原始文件名/来源标识。 */
  origin: string;
  sha256: string;
}

export interface OrientationMaterial {
  id: string;
  type: 'orientation';
  /** 拍摄方向：相对标准读胶方向的顺时针旋转角度（度）。0 为 wells 在顶。 */
  rotationDeg: Quantity; // unit 'degree'
  /** 是否水平/垂直翻转。 */
  flip: 'none' | 'horizontal' | 'vertical';
  /** 该校正所作用的原图。 */
  appliesToImageId: string;
  rawNotation: string;
}

export interface ExposureMaterial {
  id: string;
  type: 'exposure';
  exposureMs: Quantity; // unit 'ms'
  /** 饱和阈值（灰度），超过即视为饱和候选。 */
  saturationGray: Quantity; // unit 'gray'
  gain: number;
  appliesToImageId: string;
  rawNotation: string;
}

export interface LadderNominal {
  ordinal: number;
  /** 标称分子量（bp 或 kDa）。 */
  nominal: Quantity;
  /** 原始文本，无法转换时保留。 */
  raw: string;
}

export interface LadderNominalsMaterial {
  id: string;
  type: 'ladder-nominals';
  ladderLaneId: string;
  molecule: 'dna' | 'protein';
  /** 标称值按迁移顺序（自小到大分子量对应的顺序由 fromTop 说明）。 */
  bands: LadderNominal[];
  /** true 表示列表第一个是离 wells 最远（迁移最远、最小）。 */
  orderedFromBottom: boolean;
  rawNotation: string;
}

export interface LaneBoundariesMaterial {
  id: string;
  type: 'lane-boundaries';
  coordinateSystem: string;
  lanes: Array<{
    laneId: string;
    role: 'ladder' | 'sample';
    label: string;
    curve: LaneCurve;
    /** 像素级来源：该曲线来自自动检测还是人工，以及种子点。 */
    provenance: {
      source: 'auto-candidate' | 'manual-revision';
      seedPoints: PixelPoint[];
      derivedFromEventId: string;
    };
  }>;
}

export interface BandCenter {
  bandId: string;
  laneId: string;
  center: PixelPoint;
  /** 沿泳道中心线的弧长（像素），派生但随材料冻结以便溯源。 */
  arcLength: Quantity;
  /** 积分强度（灰度面积）。 */
  integrated: Quantity;
  peakGray: Quantity;
  /** 饱和/拖尾/重叠的像素证据（局部框，像素坐标）。 */
  evidence: {
    saturatedPixels: number;
    tailing: boolean;
    overlapGroupId: string | null;
    roi: { x0: number; y0: number; x1: number; y1: number; unit: 'pixel' };
  };
  provenance: {
    source: 'auto-candidate' | 'manual-revision';
    derivedFromEventId: string;
  };
}

export interface BandCentersMaterial {
  id: string;
  type: 'band-centers';
  coordinateSystem: string;
  bands: BandCenter[];
}

export type ImmutableMaterial =
  | RawImageMaterial
  | OrientationMaterial
  | ExposureMaterial

  | LadderNominalsMaterial
  | LaneBoundariesMaterial
  | BandCentersMaterial;

/** 计算参数（可修订；每次修订产生新版本，不覆盖旧版本）。 */
export interface CalibrationParams {
  paramVersion: string;
  /** 校准模型：分段对数线性插值（局部有效区域）或全局对数线性。 */
  model: 'piecewise-log-linear' | 'global-log-linear';
  /** 最小可接受的有效 ladder 点数。 */
  minLadderPoints: number;
  /** 单条泳道标尺有效区域向外延伸比例（相对首尾有效点）。 */
  extrapolationFraction: number;
  /** 是否采用“局部弧长标尺”（真）还是“同高度即同分子量”的朴素 y 标尺（假）。 */
  localArcRuler: boolean;
  /** 饱和/重叠时：仅允许候选或区间（true 强制区间，不给唯一值）。 */
  forceIntervalForAmbiguity: boolean;
  /** 计算资源预算（最大弧长采样数），耗尽返回 budget-exhausted。 */
  maxArcSamples: number;
}

/** 带位置的诊断。输入不完整时返回带位置诊断，绝不用空值/默认伪装成功。 */
export type DiagnosticCode =
  | 'MISSING_RAW_IMAGE'
  | 'MISSING_ORIENTATION'
  | 'MISSING_EXPOSURE'
  | 'MISSING_LADDER_NOMINALS'
  | 'MISSING_LANE_BOUNDARIES'
  | 'MISSING_BAND_CENTERS'
  | 'LADDER_BAND_MISSING'
  | 'NON_MONOTONIC_RULER'
  | 'DUPLICATE_MIGRATION'
  | 'OUTSIDE_VALID_REGION'
  | 'SATURATED_CANDIDATE_ONLY'
  | 'OVERLAP_INTERVAL_ONLY'
  | 'TAIL_CANDIDATE_ONLY'
  | 'UNPARSEABLE_NOMINAL'
  | 'RESOURCE_BUDGET_EXHAUSTED'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_NO_SOLUTION'
  | 'CONFLICTING_MANUAL_DECISIONS';

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  /** 像素级/对象级位置，用于界面高亮。 */
  at: {
    kind: 'pixel' | 'lane' | 'band' | 'ladder-point' | 'segment' | 'material' | 'global';
    laneId?: string;
    bandId?: string;
    ordinal?: number;
    pixel?: PixelPoint;
    materialId?: string;
  };
}

/** 计算结果的三种状态（资源预算耗尽/格式损坏/语义无解必须不同）。 */
export type ComputeStatus = 'ok' | 'budget-exhausted' | 'format-corrupt' | 'semantic-no-solution';

/** 一个插值段（局部标尺，带有效区域）。 */
export interface CalibrationSegment {
  segmentId: string;
  laneId: string;
  /** 弧长方向的有效区间（像素，弧长坐标）。 */
  sRange: { min: number; max: number; unit: 'pixel' };
  /** 分子量端点（bp/kDa）。 */
  mwLow: number;
  mwHigh: number;
  /** log10(MW) 对弧长的线性系数（仅 piecewise 段内有效）。 */
  slope: number;
  intercept: number;
  valid: boolean;
  invalidReason?: DiagnosticCode;
}

export interface LadderAssignment {
  ordinal: number;
  nominal: number;
  unit: Unit;
  bandId: string | null;
  arcLength: number | null; // 像素
  fittedLogMw: number;
  residualLog: number; // 观测 logMW - 拟合 logMW
}

export interface CalibrationResult {
  kind: 'calibration';
  laneId: string;
  status: ComputeStatus;
  segments: CalibrationSegment[];
  assignments: LadderAssignment[];
  /** 局部标尺有效区域（弧长）；微笑时每泳道独立。 */
  validRegion: { sMin: number; sMax: number; unit: 'pixel' } | null;
  diagnostics: Diagnostic[];
}

export interface MwValue {
  valueId: string; // 稳定身份，见 ids.ts
  bandId: string;
  laneId: string;
  /** 唯一值（仅当无歧义）。 */
  point: number | null;
  unit: Unit;
  /** 区间（饱和/拖尾/重叠时唯一合法表达）。 */
  interval: { low: number; high: number } | null;
  candidates: number[];
  status: 'unique' | 'candidate' | 'interval' | 'invalid';
  /** 回链到 ladder 点与插值段。 */
  evidence: {
    segmentId: string | null;
    ladderOrdinals: number[];
    arcLength: number;
    withinValidRegion: boolean;
  };
  diagnostics: Diagnostic[];
}

export interface MwInferenceResult {
  kind: 'mw-inference';
  status: ComputeStatus;
  values: MwValue[];
  diagnostics: Diagnostic[];
}

/** 自动候选条带检测结果（auto 层）。 */
export interface BandCandidate {
  candidateId: string;
  bandId: string;
  laneId: string;
  center: PixelPoint;
  arcLength: number;
  integrated: number;
  peakGray: number;
  flags: Array<'saturated' | 'tailing' | 'overlap'>;
  overlapGroupId: string | null;
}

export interface BandDetectResult {
  kind: 'band-detect';
  status: ComputeStatus;
  candidates: BandCandidate[];
  diagnostics: Diagnostic[];
}

export type NodeResult = BandDetectResult | CalibrationResult | MwInferenceResult;
export type NodeKind = NodeResult['kind'];

/** 计算节点：结果 + 输入摘要 + 参数版本 + 父级依赖（内容寻址）。 */
export interface ComputeNode {
  nodeId: string;
  kind: NodeKind;
  laneId?: string;
  status: ComputeStatus;
  result: NodeResult;
  /** 输入摘要：材料 id + sha256，保证可重放与等价输入稳定顺序。 */
  inputDigest: string;
  paramsVersion: string;
  parents: string[]; // 依赖的其他 nodeId（如 mw-inference 依赖 calibration）
  materialDeps: Array<{ materialId: string; sha256: string }>;
  computedAt: ISODateTime;
}

/** 人工决定。 */
export type DecisionKind = 'accept' | 'reject' | 'adjust-params' | 'resolve-conflict' | 'flag-conflict';

export interface Decision {
  decisionId: string;
  kind: DecisionKind;
  target:
    | { kind: 'band-candidate'; bandId: string; laneId: string }
    | { kind: 'mw-value'; valueId: string }
    | { kind: 'params' };
  /** adjust 时携带的参数覆盖。 */
  paramsOverride?: Partial<CalibrationParams>;
  note?: string;
  at: ISODateTime;
}

/** 事件（追加日志）。 */
export type EventType =
  | 'project-created'
  | 'material-recorded'
  | 'refs-updated'
  | 'params-revised'
  | 'decision-made'
  | 'compute-appended'
  | 'branch-created';

export interface EventBase {
  eventId: string;
  seq: number; // 分支内稳定顺序
  projectId: string;
  branch: string;
  parentEventId: string | null;
  at: ISODateTime;
  /** 生成该事件的自动/人工来源，便于区分自动候选与人工修订。 */
  actor: 'system' | 'reviewer';
}

export interface ProjectCreatedEvent extends EventBase {
  type: 'project-created';
  name: string;
}
export interface MaterialRecordedEvent extends EventBase {
  type: 'material-recorded';
  material: ImmutableMaterial;
}
export interface RefsUpdatedEvent extends EventBase {
  type: 'refs-updated';
  /** 当前各类型材料指针；只记录直接来源引用。 */
  refs: Partial<Record<MaterialType, string>>;
}
export interface ParamsRevisedEvent extends EventBase {
  type: 'params-revised';
  params: CalibrationParams;
  reason: string;
}
export interface DecisionMadeEvent extends EventBase {
  type: 'decision-made';
  decision: Decision;
}
export interface ComputeAppendedEvent extends EventBase {
  type: 'compute-appended';
  nodes: ComputeNode[];
}
export interface BranchCreatedEvent extends EventBase {
  type: 'branch-created';
  sourceEventId: string;
  sourceBranch: string;
  newBranch: string;
  label: string;
}

export type ProjectEvent =
  | ProjectCreatedEvent
  | MaterialRecordedEvent
  | RefsUpdatedEvent
  | ParamsRevisedEvent
  | DecisionMadeEvent
  | ComputeAppendedEvent
  | BranchCreatedEvent;

/** 分支头。 */
export interface BranchHead {
  name: string;
  label: string;
  headEventId: string;
  createdFrom: string | null;
}

/** 导出包。 */
export interface ProjectBundle {
  format: 'gel-ruler-bundle';
  formatVersion: 1;
  exportedAt: ISODateTime;
  project: { id: string; name: string; createdAt: ISODateTime };
  events: ProjectEvent[];
  branches: BranchHead[];
}
