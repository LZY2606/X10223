// ============================================================
// 胶道标尺：领域类型（电泳图像 / 泳道 / 条带 / 分子量校准）
// ============================================================

export type MassUnit = 'bp' | 'kDa' | 'nt';
export type LengthUnit = 'px';
export type Orientation = 'up' | 'right' | 'down' | 'left';
export type ResultStatus = 'accepted' | 'rejected' | 'candidate';

/** 带单位的量：原始表示保留在 raw 中，规范化数值在 value 中 */
export interface Quantity<V = number, U extends string = string> {
  value: V;
  unit: U;
  raw: string;
}

export interface PixelPoint {
  /** 修正方向后像素帧坐标（左上角原点，x 向右，y 向下） */
  x: number;
  y: number;
  /** 原始像素帧坐标（拍摄方向未修正） */
  rx: number;
  ry: number;
  frame: 'corrected';
}

export interface PixelSegment {
  start: PixelPoint;
  end: PixelPoint;
}

export type DiagnosticCode =
  | 'INPUT_INCOMPLETE'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNRESOLVABLE'
  | 'BUDGET_EXHAUSTED'
  | 'LADDER_MISSING_BAND'
  | 'NON_MONOTONIC_RULER'
  | 'SATURATED_BAND'
  | 'OVERLAPPING_BANDS'
  | 'SMEAR_TAIL'
  | 'LOCAL_RULER_INVALID'
  | 'OUTSIDE_VALID_RANGE'
  | 'CONFLICTING_DECISION';

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  at?: {
    kind: 'pixel' | 'lane' | 'band' | 'segment' | 'image' | 'event';
    point?: PixelPoint;
    ids?: string[];
    laneId?: string;
    bandId?: string;
    validRange?: { from: Quantity; to: Quantity };
  };
}

/** 三种不同的失败结果 */
export type FailureKind =
  | 'budget-exhausted'
  | 'format-corrupt'
  | 'semantic-unresolvable'
  | 'incomplete-input';

// ---------- 不可变材料层 (Immutable Materials) ----------

export interface ExposureInfo {
  /** 曝光时长，秒；保留原始表示 */
  duration: Quantity<number, 's'>;
  gain: Quantity<number, 'dB'>;
  bitDepth: 8 | 12 | 16;
  /** 饱和阈值（灰度级），超过即认为像元饱和 */
  saturationLevel: number;
  raw: string;
}

export interface ImageMaterial {
  id: string;
  kind: 'image';
  /** 原图字节的内容哈希（PNG 编码） */
  originalHash: string;
  width: number;
  height: number;
  /** 拍摄方向（原始图像方向）；不可变材料属性 */
  shotOrientation: Orientation;
  exposure: ExposureInfo;
  /** 时间基准：拍摄 UTC ISO 时间，不可变 */
  capturedAt: string;
  /** 像素数据（8-bit 灰度，长度 width*height），不随修正改变 */
  pixels: Uint8Array;
  /** 像素坐标基准说明 */
  coordinateBasis: 'image-top-left-corrected' | 'image-top-left-native';
}

export interface LadderNominal {
  /** 稳定身份（标称值内容决定） */
  id: string;
  mass: Quantity<number, MassUnit>;
  /** 可选的厂商槽位序号（1=离井最远…），仅作来源记录 */
  slot?: number;
}

export interface LadderSpec {
  id: string;
  kind: 'ladderSpec';
  name: string;
  unit: MassUnit;
  /** 标称条带，按分子量降序 */
  nominals: LadderNominal[];
  /** 标称值原始表示（导入时逐字保留） */
  rawRepresentation: string[];
}

// ---------- 可修改决定层：领域事件 ----------

export type EventKind =
  | 'image-imported'
  | 'image-rotated'
  | 'ladder-attached'
  | 'params-revised'
  | 'lanes-detected'
  | 'lane-accepted'
  | 'lane-rejected'
  | 'lane-revised'
  | 'bands-detected'
  | 'band-accepted'
  | 'band-rejected'
  | 'band-revised'
  | 'band-split-overlap'
  | 'mass-computed'
  | 'local-failure-recorded'
  | 'annotation-conflict'
  | 'project-created';

export interface EventBase {
  id: string;
  kind: EventKind;
  seq: number;
  branch: string;
  parentId: string | null;
  timestamp: string;
  author: 'auto' | 'reviewer' | 'importer';
  /** 输入摘要（哈希） */
  inputSummary?: string;
  /** 参数版本 */
  paramsVersion?: string;
  /** 父级依赖（稳定身份） */
  dependsOn?: string[];
  /** 事件载荷哈希链前序（tamper evidence） */
  prevChainHash?: string;
  chainHash?: string;
}

export interface ImageImportedPayload {
  imageId: string;
  shotOrientation: Orientation;
  exposure: ExposureInfo;
}
export interface ImageRotatedPayload {
  imageId: string;
  from: Orientation;
  to: Orientation;
}
export interface LadderAttachedPayload {
  ladderId: string;
  laneId?: string;
}
export interface ParamsRevisedPayload {
  fromVersion: string;
  toVersion: string;
  changes: Record<string, number | string | boolean>;
  scope?: 'global' | { laneId: string };
}

export interface LaneCurveSource {
  type: 'auto' | 'manual';
  controlPoints: PixelPoint[];
  /** 自动来源：检测时的输入摘要 */
  detectionInputSummary?: string;
}

export interface LaneRecord {
  id: string;
  index: number;
  /** 泳道边界（左右曲线控制点），像素级来源 */
  leftBoundary: PixelPoint[];
  rightBoundary: PixelPoint[];
  /** 泳道中心线（由边界导出或人工修订） */
  centerline: LaneCurveSource;
  status: ResultStatus;
  /** 井位置（迁移距离 0 点），修正帧 */
  well: PixelPoint;
  confidence?: number;
}

export interface LanesDetectedPayload {
  imageId: string;
  lanes: LaneRecord[];
  paramsVersion: string;
  diagnostics: Diagnostic[];
}
export interface LaneAcceptedPayload {
  laneId: string;
}
export interface LaneRejectedPayload {
  laneId: string;
  reason: string;
}
export interface LaneRevisedPayload {
  laneId: string;
  oldSource: LaneCurveSource;
  newSource: LaneCurveSource;
  reason: string;
}

export interface BandRecord {
  id: string;
  laneId: string;
  /** 条带中心，像素级来源（修正帧 + 原始帧） */
  center: PixelPoint;
  width: number;
  height: number;
  /** 沿泳道中心线的迁移弧长（px, corrected 帧） */
  migration?: number;
  peakIntensity: number;
  saturated: boolean;
  saturatedPixelCount: number;
  smear: boolean;
  /** 与其他条带重叠（合法时保留全部候选） */
  overlapsWith: string[];
  status: ResultStatus;
  source: 'auto' | 'manual';
  /** 重叠/拖尾/饱和时只能给区间 */
  candidateCenters?: PixelPoint[];
}

export interface BandsDetectedPayload {
  imageId: string;
  laneId: string;
  bands: BandRecord[];
  diagnostics: Diagnostic[];
}
export interface BandAcceptedPayload {
  bandId: string;
}
export interface BandRejectedPayload {
  bandId: string;
  reason: string;
}
export interface BandRevisedPayload {
  bandId: string;
  oldCenter: PixelPoint;
  newCenter: PixelPoint;
  reason: string;
}
export interface BandSplitOverlapPayload {
  parentBandId: string;
  chosenBandIds: string[];
  allLegalBandIds: string[];
  note: string;
}

export interface LadderAssignmentPoint {
  nominalId: string;
  mass: Quantity<number, MassUnit>;
  bandId: string;
  center: PixelPoint;
  migration: number;
  /** 相对量（log10 分子量） */
  logMass: number;
}

export interface FitSegment {
  id: string;
  startNominalId: string;
  endNominalId: string;
  startBandId: string;
  endBandId: string;
  /** 线性 log-mass ~ migration 的斜率与截距（局部段） */
  slope: number;
  intercept: number;
  /** 该段有效区域：迁移距离区间 [from,to] px */
  validFromMigration: number;
  validToMigration: number;
  residual: number;
}

export interface LadderCalibration {
  ladderLaneId: string;
  ladderId: string;
  points: LadderAssignmentPoint[];
  segments: FitSegment[];
  /** 全局回归残差（逐点） */
  globalResiduals: { nominalId: string; residual: number }[];
  validRange: { from: Quantity<number, MassUnit>; to: Quantity<number, MassUnit> };
  nonMonotonic: boolean;
  diagnostics: Diagnostic[];
}

export interface MassResult {
  id: string;
  bandId: string;
  laneId: string;
  /** 唯一分子量；区间或候选时为 null */
  mass: Quantity<number, MassUnit> | null;
  /** 区间估计（饱和/拖尾/重叠时） */
  range?: { from: Quantity<number, MassUnit>; to: Quantity<number, MassUnit> };
  /** 全部合法候选（无法唯一决定时） */
  candidates?: Quantity<number, MassUnit>[];
  migration: number;
  /** 使用的标尺段身份（点击回溯锚点） */
  segmentId?: string;
  usedLadderPointIds: string[];
  status: ResultStatus | 'range' | 'ambiguous' | 'out-of-range' | 'invalid';
  reason?: string;
  diagnostics: Diagnostic[];
  paramsVersion: string;
  parentResultIds: string[];
}

export interface MassComputedPayload {
  imageId: string;
  calibration: LadderCalibration | null;
  results: MassResult[];
  diagnostics: Diagnostic[];
  inputSummary: string;
  paramsVersion: string;
}

export interface LocalFailurePayload {
  laneId?: string;
  bandId?: string;
  kind: 'non-monotonic' | 'missing-band' | 'out-of-range' | 'post-revision-invalid';
  affectedIds: string[];
  message: string;
  diagnostics: Diagnostic[];
}

export interface AnnotationConflictPayload {
  objectType: 'band' | 'lane';
  objectId: string;
  conflictingEventIds: string[];
  resolution: 'unresolved' | 'accepted-latest' | 'rejected';
  message: string;
}

export type DomainEvent = EventBase &
  (
    | ({ kind: 'project-created' } & { payload: { name: string; casePackVersion: string } })
    | ({ kind: 'image-imported' } & { payload: ImageImportedPayload })
    | ({ kind: 'image-rotated' } & { payload: ImageRotatedPayload })
    | ({ kind: 'ladder-attached' } & { payload: LadderAttachedPayload })
    | ({ kind: 'params-revised' } & { payload: ParamsRevisedPayload })
    | ({ kind: 'lanes-detected' } & { payload: LanesDetectedPayload })
    | ({ kind: 'lane-accepted' } & { payload: LaneAcceptedPayload })
    | ({ kind: 'lane-rejected' } & { payload: LaneRejectedPayload })
    | ({ kind: 'lane-revised' } & { payload: LaneRevisedPayload })
    | ({ kind: 'bands-detected' } & { payload: BandsDetectedPayload })
    | ({ kind: 'band-accepted' } & { payload: BandAcceptedPayload })
    | ({ kind: 'band-rejected' } & { payload: BandRejectedPayload })
    | ({ kind: 'band-revised' } & { payload: BandRevisedPayload })
    | ({ kind: 'band-split-overlap' } & { payload: BandSplitOverlapPayload })
    | ({ kind: 'mass-computed' } & { payload: MassComputedPayload })
    | ({ kind: 'local-failure-recorded' } & { payload: LocalFailurePayload })
    | ({ kind: 'annotation-conflict' } & { payload: AnnotationConflictPayload })
  );

// ---------- 参数（版本化） ----------

export interface DetectorParams {
  paramsVersion: string;
  laneBandwidth: number;
  laneDarkThreshold: number;
  bandProminence: number;
  bandMinHeight: number;
  saturationThreshold: number;
  overlapSeparationPx: number;
  smearTailRatio: number;
  maxLanes: number;
  maxBandsPerLane: number;
}

export const DEFAULT_PARAMS: DetectorParams = {
  paramsVersion: 'params-v1',
  laneBandwidth: 9,
  laneDarkThreshold: 40,
  bandProminence: 18,
  bandMinHeight: 4,
  saturationThreshold: 250,
  overlapSeparationPx: 6,
  smearTailRatio: 2.5,
  maxLanes: 24,
  maxBandsPerLane: 30,
};

export interface ProjectMeta {
  id: string;
  name: string;
  casePackVersion: string;
  createdAt: string;
}
