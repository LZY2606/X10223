// 领域核心类型：所有领域量携带单位 / 坐标基准；不可变材料与可修改决定分层。

export type Unit = 'bp' | 'kDa' | 'mm' | 'px';

/** 带单位的原始表示（导入时保留，不做转换时留在原位并附诊断） */
export interface Quantity {
  value: number | string;
  unit: string;
  /** 导入层解析后的数值；无法转换时为 null，并保留诊断 */
  parsed: number | null;
  rawText?: string;
}

/** 坐标基准：所有像素坐标必须声明基准 */
export interface CoordFrame {
  /** 原图坐标 raw | 标准方向坐标 upright（绕图像中心旋转到竖直迁移方向后） */
  kind: 'raw' | 'upright';
  /** 相对 upright 的顺时针角度（度），raw 帧坐标由该方向反变换 */
  rotationDeg: number;
  unit: 'px';
  width: number;
  height: number;
}

export interface Point {
  x: number;
  y: number;
}

/** 不可变材料：原始凝胶图像（像素级来源） */
export interface ImageMaterial {
  id: string;
  kind: 'image';
  filename: string;
  mediaType: 'image/png';
  /** 原始字节的稳定哈希（内容身份，不是行号） */
  sha256: string;
  widthPx: number;
  heightPx: number;
  /** 像素值位深 / 通道数，供饱和判定使用 */
  channels: number;
  maxIntensity: number;
  /** 拍摄方向（degree=顺时针，来源 explicit|exif|assumed） */
  orientation: {
    degreesClockwise: 0 | 90 | 180 | 270;
    source: 'explicit' | 'exif' | 'assumed';
  };
  /** 曝光：秒、增益、是否欠/过曝；像素级来源（整幅图像统计） */
  exposure: {
    exposureTimeSec: number | null;
    gain: number | null;
    saturatedPixelFraction: number;
    p99Intensity: number;
    source: 'exif' | 'measured';
  };
}

/** 泳道：边界与中心线均为原始像素坐标（像素级来源） */
export interface LaneMaterial {
  id: string;
  kind: 'lane';
  imageId: string;
  index: number;
  label: string;
  /** 左右边界折线（raw 像素坐标） */
  leftBoundary: Point[];
  rightBoundary: Point[];
  /** 泳道中心曲线（“微笑”弯曲的载体） */
  centerline: Point[];
  source: 'auto-detected' | 'manual';
  /** 该泳道是否存在明显弯曲（微笑/皱眉） */
  curvature: 'straight' | 'smile' | 'frown' | 'warped';
}

/** 条带：中心保留像素级来源；饱和/拖尾/重叠只给候选或区间 */
export interface BandMaterial {
  id: string;
  kind: 'band';
  laneId: string;
  /** 条带中心（raw 像素坐标） */
  center: Point;
  /** 沿泳道中心曲线的弧长位置（px，从迁移远端起算），派生但缓存 */
  alongPx: number;
  /** 垂直方向跨距（px），用于重叠/拖尾判断 */
  halfWidthPx: number;
  peakIntensity: number;
  saturated: boolean;
  smear: boolean;
  /** 与其它条带重叠时的对端 id */
  overlapsWith: string[];
  status: 'candidate' | 'confirmed' | 'rejected';
  source: 'auto-detected' | 'manual';
  /** 人工指定的 ladder 标称对齐（非单调标尺场景的直接来源） */
  ladderNominalId?: string;
}

/** Ladder 标称值：原始表示保留（bp / kDa 或带单位字符串） */
export interface LadderBandNominal {
  id: string;
  /** 标称分子量，导入时保留原始表示 */
  nominal: Quantity;
  /** 期望相对位置提示（可空）：1=最远迁移端，0=加样孔端 */
  migrationHint: number | null;
  /** 本次标尺缺失（缺带场景） */
  missing?: boolean;
}

export interface LadderMaterial {
  id: string;
  kind: 'ladder';
  laneId: string;
  unit: 'bp' | 'kDa';
  nominals: LadderBandNominal[];
  source: 'catalog' | 'manual';
  catalogName?: string;
}

/** 可修改决定层：参数版本 */
export interface ParameterSet {
  id: string;
  version: number;
  /** 标尺插值模型：log-线性分段（bp 默认 log10） */
  model: 'piecewise-log-linear';
  /** 饱和阈值（像素强度占比） */
  saturationThreshold: number;
  /** 重叠判定：沿弧方向中心距小于该倍数半宽之和 */
  overlapHalfWidthFactor: number;
  /** 缺带是否允许跨缺口（桥接）插值；桥接段降级为区间 */
  bridgeMissingBands: boolean;
  /** 非单调容差（log10 分子量，正数） */
  monotonicTolerance: number;
  /** 有效区间是否禁止外推 */
  forbidExtrapolation: boolean;
  notes?: string;
}

export interface MaterialBundle {
  image: ImageMaterial;
  lanes: LaneMaterial[];
  bands: BandMaterial[];
  ladder: LadderMaterial;
}

// ---- 诊断（带位置；不得用空值/默认伪装成功） ----

export interface Diagnostic {
  code:
    | 'MISSING_REQUIRED_FIELD'
    | 'UNPARSEABLE_UNIT'
    | 'BAD_COORDINATE'
    | 'NONMONOTONIC_RULER'
    | 'LADDER_BAND_MISSING'
    | 'SATURATED_BAND'
    | 'OVERLAPPING_BANDS'
    | 'SMEARED_BAND'
    | 'OUTSIDE_VALID_RANGE'
    | 'EXTRAPOLATION_FORBIDDEN'
    | 'SEMANTIC_UNRESOLVABLE'
    | 'REVISION_LOCAL_INVALIDATION'
    | 'BUDGET_EXHAUSTED'
    | 'FORMAT_CORRUPT'
    | 'DEPRECATED_BY_REVISION';
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 位置：对象身份 + 片段路径（像素/字段位置） */
  at: {
    objectId?: string;
    objectKind?: string;
    path?: string;
    pixel?: Point;
    segmentIndex?: number;
  };
}

/** 三类必须可区分的结果 */
export type OutcomeKind = 'ok' | 'budget-exhausted' | 'format-corrupt' | 'semantic-unresolvable';

// ---- 事件溯源（可重放证据，不只是日志） ----

export type EventPayload =
  | { type: 'PROJECT_CREATED'; slug: string; name: string }
  | { type: 'MATERIALS_IMPORTED'; bundle: MaterialBundle; rawRepresentation: Record<string, unknown> }
  | { type: 'PARAMETERS_REVISED'; fromParamsId: string | null; toParamsId: string; reason: string }
  | { type: 'SOURCE_PATCHED'; objectKind: string; objectId: string; field: string; before: unknown; after: unknown }
  | { type: 'AUTO_CANDIDATES_COMPUTED'; resultId: string }
  | { type: 'BAND_DECISION'; bandId: string; decision: 'accepted' | 'rejected' | 'adjusted'; adjustment?: Point; reason: string }
  | { type: 'MW_DECISION'; inferenceId: string; decision: 'accepted' | 'rejected' | 'range-only'; reason: string }
  | { type: 'CONFLICTING_DECISION'; inferenceId: string; priorDecision: string; reason: string }
  | { type: 'COUNTEREXAMPLE_RUN'; scenario: string; mutation: string; affectedObjectIds: string[]; status: string };

export interface DomainEvent {
  seq: number;
  id: string;
  parentEventId: string | null;
  projectId: string;
  atTime: string;
  payload: EventPayload;
  /** 该事件应用后的状态快照引用（回到旧事件时恢复当时结论） */
  stateRef: string;
}

// ---- 派生层：计算结果（输入摘要 + 参数版本 + 父级依赖） ----

export interface Provenance {
  inputSha256: string;
  paramsId: string;
  parentResultIds: string[];
  eventSeq: number;
  computedAt: string;
}

export interface CalibrationSegment {
  index: number;
  /** 插值两端的 ladder 标称点（bp/kDa）与沿弧位置 px */
  low: { nominalParsed: number; alongPx: number; nominalId: string };
  high: { nominalParsed: number; alongPx: number; nominalId: string };
  /** 沿弧有效区间（px）；微笑弯曲下同一 y 不等于同一分子量，标尺按弧长且带有效区域 */
  validAlong: [number, number];
  valid: boolean;
  bridge: boolean;
  /** 全局 log-线性拟合残差（log10 单位） */
  residualLog: number;
  diagnostics: Diagnostic[];
}

export interface LadderMatch {
  nominalId: string;
  bandId: string | null;
  alongPx: number | null;
  matched: boolean;
  diagnostic?: Diagnostic;
}

export interface CalibrationResult {
  id: string;
  ladderId: string;
  laneId: string;
  unit: 'bp' | 'kDa';
  matches: LadderMatch[];
  segments: CalibrationSegment[];
  /** 标尺整体有效沿弧区间（禁止外推） */
  globalValidAlong: [number, number] | null;
  residuals: { bandId: string; alongPx: number; residualLog: number }[];
  diagnostics: Diagnostic[];
  provenance: Provenance;
}

export type MwStatus =
  | 'unique'
  | 'candidate-set'
  | 'range-only'
  | 'invalid-outside-range'
  | 'invalid-nonmonotonic'
  | 'invalid-saturated-point'
  | 'invalid-revision';

export interface MwCandidate {
  id: string;
  value: number;
  unit: 'bp' | 'kDa';
  segmentIndex: number;
  /** 反查路径：ladder 点与插值段 */
  ladderPointIds: [string, string];
  valid: boolean;
}

export interface BandInference {
  id: string;
  bandId: string;
  laneId: string;
  alongPx: number;
  /** 区间（无法唯一决定时给区间，保留全部合法候选） */
  range: { low: number; high: number; unit: 'bp' | 'kDa' } | null;
  point: number | null;
  unit: 'bp' | 'kDa';
  status: MwStatus;
  candidates: MwCandidate[];
  invalidReason: string | null;
  calibrationId: string;
  diagnostics: Diagnostic[];
  provenance: Provenance;
}

export interface ComputationResult {
  calibration: CalibrationResult;
  inferences: BandInference[];
  outcome: OutcomeKind;
  diagnostics: Diagnostic[];
}

/** 反例档案条目：采纳与未采纳结果都保留 */
export interface CounterexampleRecord {
  scenario: string;
  label: string;
  baselineOnlySourceChanged: string;
  mutationDescription: string;
  inputFragment: unknown;
  status: OutcomeKind | 'contained' | 'invalidated-local';
  affectedObjectIds: string[];
  /** 影响是否被限制在正确范围 */
  containmentAssertion: string;
  adopted: { inferenceId: string; status: MwStatus } | null;
  rejected: { inferenceId: string; status: MwStatus; reason: string }[];
  events: { type: string; at: { objectId?: string; path?: string; pixel?: Point } }[];
}

export interface ProjectState {
  projectId: string;
  slug: string;
  name: string;
  materials: MaterialBundle | null;
  params: ParameterSet[];
  currentParamsId: string | null;
  events: DomainEvent[];
  /** seq -> 计算结果（每次事件后结论不可变） */
  resultsBySeq: Record<number, ComputationResult>;
  headSeq: number;
  decisions: { bandId: string; accepted: boolean; rangeOnly: boolean; atSeq: number; reason: string }[];
}
