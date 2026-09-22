// 核心领域类型。所有领域量携带单位或坐标基准；原图材料不可变。

export type Unit =
  | 'pixel'        // 像素
  | 'bp'           // 核酸碱基对
  | 'kDa'          // 蛋白分子量
  | 'gray16'       // 16 位灰度（曝光/饱和）
  | 'degree'       // 角度
  | 'dimensionless'
  | 'eventIndex';  // 时间基准：事件序号

export interface Quantity {
  value: number;
  unit: Unit;
  // 规范化后的值（派生层）；原始表示始终保留在 raw 字段
  valueCanonical?: number;
  raw?: string; // 导入时的原始表示
  basis?: string; // 坐标/时间基准说明
}

export interface PixelPoint {
  x: number; // pixel，原图左上角为原点，x 向右
  y: number; // pixel，y 向电泳迁移方向
}

// 带像素级来源的点：记录它来自哪条不可变材料、哪一版、以及材料内坐标基准
export interface SourcedPoint {
  x: number;
  y: number;
  unit: 'pixel';
  frame: 'raw' | 'display'; // raw=原图坐标；display=当前显示坐标（仅渲染用）
  sourceMaterialId: string;
  sourceVersionId: string;
  basis: string; // 例如 "raw-image#0 左上角原点，未经旋转校正"
  detectedAt?: string; // 时间基准 event id
}

export interface PixelPolyline {
  points: SourcedPoint[];
  closed: boolean;
}

export interface OriginRef {
  origin: 'auto' | 'manual' | 'replay' | 'import';
  eventId: string;
  parentVersionIds: string[]; // 父级依赖：由哪些材料版本/派生版本算出
}

export type MaterialKind =
  | 'rawImage'
  | 'orientation'
  | 'exposure'
  | 'ladderNominal'
  | 'laneBoundary'
  | 'bandCenter';

// ---- 不可变材料（只追加新版本，永不覆盖）----
export interface Material {
  id: string;
  kind: MaterialKind;
  versionId: string;
  supersedesVersionId?: string;
  createdAtEventId: string;
  origin: OriginRef['origin'];
  basis: string; // 坐标/单位基准
  data: MaterialData;
}

export interface RawImageData {
  blobId: string;
  width: number;
  height: number;
  channels: 1;
  bitDepth: 16;
  pixelBasis: string; // 坐标基准说明
  generatorHint?: string;
}

export interface OrientationData {
  rotationDeg: number; // 相对“迁移方向向下”需要顺时针旋转的角度
  flipX: boolean;
  confidence: number;
  basis: string;
}

export interface ExposureData {
  maxIntensity: number;
  saturatedAbove: number; // 灰度 >= 该值判为饱和
  bitDepth: 16;
  unit: 'gray16';
  basis: string;
}

export interface LadderBandNominal {
  order: number; // 从上到下（迁移从小到大）序号 0..
  raw: string;   // 原始表示
  value: number | null; // 规范化失败时为 null，诊断留在原位
  unit: 'bp' | 'kDa';
  parseDiagnostic?: string;
}

export interface LadderNominalData {
  laneLabel: string;
  bands: LadderBandNominal[];
  basis: string;
}

export type MaterialData =
  | RawImageData
  | OrientationData
  | ExposureData
  | LadderNominalData
  | LaneBoundaryData
  | BandCenterData;

export interface LaneBoundaryData {
  laneLabel: string;
  centerline: PixelPolyline; // 泳道中心线
  leftEdge?: PixelPolyline;
  rightEdge?: PixelPolyline;
  widthPx: number;
  basis: string;
}

export interface BandCenterData {
  laneLabel: string;
  order: number;
  center: SourcedPoint;
  // 在泳道中心线上的弧长迁移坐标 s（派生测量，但中心点来源是像素）
  profileContour?: SourcedPoint[]; // 条带轮廓（跨泳道宽度采样）
  localMaxIntensity?: number;
  saturated: boolean;
  tailing: boolean;
  basis: string;
}

// ---- 派生结果 ----
export interface ContourSample {
  point: SourcedPoint;
  intensity: number;
}

export interface Band {
  id: string;
  laneLabel: string;
  order: number;
  center: SourcedPoint;
  s: number; // 沿中心线弧长，pixel
  contour: ContourSample[];
  localMaxIntensity: number;
  saturated: boolean;
  tailing: boolean;
  peakWidth: number; // pixel
  overlapGroupId?: string;
  origin: OriginRef;
}

export interface LaneCurve {
  laneLabel: string;
  centerline: SourcedPoint[];
  // 折线弧长参数 s -> 像素坐标
  arc: { s: number; x: number; y: number }[];
  widthPx: number;
  smileCurvature: number; // 中心线横向偏移量度，pixel；0 表示直线
  validSRange: { min: number; max: number };
  origin: OriginRef;
}

export type SegmentStatus = 'valid' | 'rejectedNonMonotonic' | 'rejectedSlope' | 'outOfRange';

export interface CalibrationSegment {
  id: string;
  laneLabel: string;
  ladderBandIdA: string;
  ladderBandIdB: string;
  nominalA: number;
  nominalB: number;
  unit: 'bp' | 'kDa';
  sA: number;
  sB: number;
  // log10(MW) = intercept + slope * s
  slope: number;
  intercept: number;
  rmsResidual: number;
  status: SegmentStatus;
  invalidReason?: string;
  validSRange: { min: number; max: number };
  origin: OriginRef;
  paramVersion: string;
}

export type EstimateStatus = 'unique' | 'candidateSet' | 'interval' | 'invalid';

export interface MwCandidate {
  value: number;
  segmentId: string;
  ladderPointIds: [string, string];
  logResidual: number;
}

export interface Estimate {
  id: string;
  bandId: string;
  laneLabel: string;
  s: number;
  unit: 'bp' | 'kDa';
  value: number | null;       // unique 时有值
  low?: number;
  high?: number;              // interval 范围
  candidates: MwCandidate[];  // 无法唯一决定时保留全部合法候选
  status: EstimateStatus;
  invalidReason?: string;
  withinCalibration: boolean;
  fitResidualLog: number | null;
  origin: OriginRef;
  paramVersion: string;
}

export type DiagnosticSeverity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  at: { kind: MaterialKind | 'band' | 'lane' | 'estimate'; id: string; path?: string };
  message: string;
}

export interface Run {
  id: string;
  eventId: string;
  kind: 'autoDetect' | 'reviseAndRecompute' | 'archiveScenario';
  paramVersion: string;
  inputSummary: Record<string, unknown>; // 输入摘要（材料版本 id 与哈希）
  parentVersionIds: string[];
  lanes: LaneCurve[];
  bands: Band[];
  ladderBandIds: string[];
  segments: CalibrationSegment[];
  estimates: Estimate[];
  diagnostics: Diagnostic[];
  // 拟合残差序列（供复核界面叠加）
  residuals: { bandId: string; s: number; logResidual: number }[];
}

// ---- 事件（机器可读取的判定依据）----
export type EventType =
  | 'projectCreated'
  | 'materialAdded'
  | 'autoDetectRun'
  | 'manualRevision'
  | 'decision'
  | 'parameterRevision'
  | 'scenarioReplay'
  | 'importCheckpoint';

export type DecisionVerdict = 'accepted' | 'rejected' | 'adjusted';

export interface Event {
  id: string;
  seq: number;            // 稳定顺序（时间基准）
  branchId: string;
  parentEventId: string | null;
  type: EventType;
  at: string;             // 逻辑时钟标签，如 seq@branch
  payload: EventPayload;
}

export interface EventPayload {
  kind: EventType;
  summary: string;
  materialId?: string;
  materialVersionId?: string;
  runId?: string;
  verdict?: DecisionVerdict;
  targetEstimateId?: string;
  paramVersion?: string;
  scenario?: ScenarioName;
  affectedObjectIds?: string[];
  evidence?: Record<string, unknown>;
}

export type ScenarioName =
  | 'baseline'
  | 'rotation'
  | 'smileCurvedLane'
  | 'ladderMissingBand'
  | 'saturation'
  | 'overlappingBands'
  | 'nonMonotonicRuler'
  | 'revisionLocalInvalidation'
  | 'conflictingDecisions';

export interface Branch {
  id: string;
  label: string;
  forkedFromEventId: string | null;
  createdAtSeq: number;
}
