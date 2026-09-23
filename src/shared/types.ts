// 胶道标尺：电泳条带、泳道弯曲与分子量校准工作台 —— 领域类型
// 所有领域量均携带单位或坐标基准；原始表示在材料层保留，派生层才规范化。

export type MWUnit = 'bp' | 'kDa';
export type LengthUnit = 'px' | 'mm';

export interface Quantity {
  value: number;
  unit: string;
  rawRepresentation?: string;
}

export interface Vec2 {
  x: number;
  y: number;
}

/** 像素级来源：任何点都必须能回到某张图像材料上的像素坐标。 */
export interface PixelSource {
  imageMaterialId: string;
  /** 像素坐标（允许亚像素），坐标基准 = imageMaterialId 所指图像的左上角像素。 */
  x: number;
  y: number;
  xUnit: 'px';
  yUnit: 'px';
  origin: 'auto' | 'manual' | 'import';
  createdByEventId?: string;
  /** 0..1，自动检测置信度；人工点为 1。 */
  confidence?: number;
  note?: string;
}

export interface Polyline {
  frame: string; // imageMaterialId，坐标基准
  points: Vec2[];
}

export interface ExposureFact {
  exposureTimeMs: number | null;
  gain: number | null;
  illuminant: string | null;
  bitDepth: number;
  saturationValue: number; // 该位深下的饱和灰度
  rawRepresentation: string; // 导入时的原始文本，逐字保留
}

export interface OrientationFact {
  /** 拍摄时相对电泳迁移方向的旋转角（0/90/180/270，顺时针）。 */
  captureRotationDeg: 0 | 90 | 180 | 270;
  flipH: boolean;
  rawRepresentation: string;
}

export interface ImageBlobRef {
  sha256: string;
  path: string; // 项目包内相对路径
  byteLength: number;
}

export interface RawImageMaterial {
  type: 'raw-image';
  id: string;
  name: string;
  format: 'raw8'; // 自有无损格式：8 位灰度 + 头
  width: number;
  height: number;
  blob: ImageBlobRef;
  pixelSpacing: { x: number; y: number; unit: 'mm/px' };
  capturedAt: string; // ISO8601，时间基准
  timeBasis: string;
  exposure: ExposureFact;
  orientation: OrientationFact;
  origin: 'import';
}

export type ImageTransform =
  | { kind: 'rotate'; deg: 90 | 180 | 270 }
  | { kind: 'crop'; region: { x: number; y: number; w: number; h: number } };

export interface DerivedImageMaterial {
  type: 'derived-image';
  id: string;
  name: string;
  parentImageId: string;
  transform: ImageTransform;
  format: 'raw8';
  width: number;
  height: number;
  blob: ImageBlobRef;
  pixelSpacing: { x: number; y: number; unit: 'mm/px' };
  derivedAt: string;
  derivedByEventId: string;
}

export type ImageMaterial = RawImageMaterial | DerivedImageMaterial;

export interface LadderNominalBand {
  ordinal: number;
  molecularWeight: { value: number; unit: MWUnit };
  rawRepresentation: string;
}

export interface LadderSpecMaterial {
  type: 'ladder-spec';
  id: string;
  name: string;
  unit: MWUnit;
  /** 标称值按分子量从大到小（迁移慢→快）。 */
  bands: LadderNominalBand[];
  /** 原始文本逐字保留，无法转换的值留在原位置。 */
  rawRepresentation: string;
  origin: 'import' | 'manual';
}

export type LaneRole = 'ladder' | 'sample';

export interface LaneGeometryMaterial {
  type: 'lane-geometry';
  id: string;
  imageId: string; // 坐标基准
  ordinal: number; // 从左到右的稳定序号
  label: string;
  role: LaneRole;
  ladderSpecId?: string;
  centerline: Polyline;
  leftBoundary: Polyline;
  rightBoundary: Polyline;
  /** 边界点的像素级来源（自动或人工）。 */
  anchorSources: PixelSource[];
  origin: 'auto' | 'manual' | 'import';
  supersedes?: string; // 人工修订所替换的上一版 lane 几何
  createdByEventId?: string;
}

export type BandFlag = 'normal' | 'saturated' | 'tail' | 'overlap' | 'missing-ladder-band';

export interface SampledProfile {
  frame: string;
  direction: 'along-lane' | 'across-lane';
  /** 起点像素与采样间距（mm）。 */
  originPx: Vec2;
  stepMm: number;
  values: number[]; // 0..255
}

export interface BandObservationMaterial {
  type: 'band-observation';
  id: string;
  imageId: string;
  laneOrdinal: number;
  /** 条带中心，像素级来源。 */
  center: PixelSource;
  /** 条带轮廓（像素折线，闭合）。 */
  contour: Polyline;
  alongProfile: SampledProfile;
  acrossProfile: SampledProfile;
  peakIntensity: number;
  saturatedFraction: number; // 饱和像素占比 0..1
  flags: BandFlag[];
  /** 重叠的另一条带材料 id（若有）。 */
  overlapBandIds: string[];
  widthMm: number;
  rawRepresentation?: string;
  origin: 'auto' | 'manual' | 'import';
  supersedes?: string;
  createdByEventId?: string;
}

export type Material =
  | ImageMaterial
  | LadderSpecMaterial
  | LaneGeometryMaterial
  | BandObservationMaterial;

export type MaterialType = Material['type'];

// ---------------------------------------------------------------------------
// 诊断（带位置，不允许用空值/默认值伪装成功）
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'error' | 'warning' | 'info';
export type DiagnosticCode =
  | 'INCOMPLETE_INPUT'
  | 'UNCONVERTIBLE_VALUE'
  | 'MISSING_PIXEL_SOURCE'
  | 'COORDINATE_FRAME_MISMATCH'
  | 'LADDER_BAND_MISSING'
  | 'NON_MONOTONIC_CALIBRATION'
  | 'SATURATED_BAND'
  | 'TAILING_BAND'
  | 'OVERLAPPING_BANDS'
  | 'OUT_OF_CALIBRATION_RANGE'
  | 'LOCAL_RULER_INVALID'
  | 'SMILE_SAME_HEIGHT_DIFFERENT_MW'
  | 'REVISION_LOCAL_INVALIDATION'
  | 'BUDGET_EXHAUSTED'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_NO_SOLUTION'
  | 'CONFLICTING_DECISIONS';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: DiagnosticSeverity;
  message: string;
  /** 带位置：材料 id / 事件 id / 像素坐标 / 字段路径。 */
  location: {
    materialId?: string;
    eventId?: string;
    resultId?: string;
    pixel?: { imageId: string; x: number; y: number; unit: 'px' };
    path?: string;
    laneOrdinal?: number;
  };
}

// ---------------------------------------------------------------------------
// 计算结果（不可变；记录输入摘要、参数版本、父级依赖）
// ---------------------------------------------------------------------------

export interface InputSummary {
  /** 参与计算的材料/结果内容 id 与各自 sha256 摘要。 */
  deps: { id: string; sha256: string }[];
  materialCount: number;
  note?: string;
}

export interface CalibrationSegment {
  id: string;
  fromLadderBandObsId: string;
  toLadderBandObsId: string;
  fromNominalOrdinal: number;
  toNominalOrdinal: number;
  /** log10(MW) = intercept + slope * arcLengthMm */
  slope: number;
  intercept: number;
  /** 局部标尺的有效区域：弧长区间 + 适用泳道。 */
  validRegion: {
    laneOrdinal: number;
    sMinMm: number;
    sMaxMm: number;
  };
  monotonic: boolean;
}

export interface CalibrationResult {
  kind: 'calibration';
  id: string;
  imageId: string;
  laneGeometryId: string;
  ladderSpecId: string;
  ladderBandObsIds: string[];
  paramsVersion: string;
  inputSummary: InputSummary;
  parentDependencies: string[];
  status: 'ok' | 'warning' | 'invalid';
  segments: CalibrationSegment[];
  residuals: {
    bandObsId: string;
    nominalMW: number;
    arcLengthMm: number;
    predictedLog10MW: number;
    observedLog10MW: number;
    residualMm: number;
  }[];
  diagnostics: Diagnostic[];
  computedAt: string;
}

export type MWCandidateReason =
  | 'interpolated'
  | 'saturated-center'
  | 'tailing'
  | 'overlap';

export interface MWCandidate {
  id: string;
  value: { value: number; unit: MWUnit };
  segmentId: string;
  /** 回到插值段两端的 ladder 点（条带观测 id）。 */
  ladderPointIds: [string, string];
  arcLengthMm: number;
  confidence: number;
  reason: MWCandidateReason;
}

export interface MolecularWeightResult {
  kind: 'molecular-weight';
  id: string;
  imageId: string;
  bandObsId: string;
  laneGeometryId: string;
  calibrationId: string;
  paramsVersion: string;
  inputSummary: InputSummary;
  parentDependencies: string[];
  status: 'unique' | 'candidate-set' | 'interval' | 'out-of-range' | 'invalid';
  arcLengthMm: number | null;
  candidates: MWCandidate[];
  interval?: { min: { value: number; unit: MWUnit }; max: { value: number; unit: MWUnit } };
  diagnostics: Diagnostic[];
  computedAt: string;
}

export type ComputationResult = CalibrationResult | MolecularWeightResult;

// ---------------------------------------------------------------------------
// 事件 / 决定（事件溯源，分支 DAG）
// ---------------------------------------------------------------------------

export type DecisionVerdict = 'accepted' | 'rejected' | 'adjusted';

export interface Decision {
  verdict: DecisionVerdict;
  targetMaterialId?: string; // 被接受/否定的候选材料
  targetResultId?: string; // 被接受/否定的计算结果
  replacementMaterialId?: string; // 调整后新材料
  reason: string;
}

export type EventKind =
  | 'project-created'
  | 'material-added'
  | 'auto-candidates'
  | 'revision'
  | 'source-edit'
  | 'decision'
  | 'branch-created'
  | 'note';

export interface EventNode {
  id: string; // 稳定身份：分支内序号 + 内容哈希
  seq: number; // 该事件在其分支上的序号（等价输入稳定顺序）
  kind: EventKind;
  branchId: string;
  parentIds: string[]; // DAG 父事件
  timestamp: string;
  actor: 'system' | 'auto' | 'reviewer';
  summary: string;
  materialIds: string[];
  resultIds: string[]; // 当时可见结论的快照
  decision?: Decision;
  /** 参数修订版本（语义版本字符串）。 */
  paramsVersion: string;
  inputSummary: InputSummary;
  parentDependencies: string[];
  diagnostics: Diagnostic[];
  /** 互相冲突的人工决定：两条分支/事件都保留并互相标记。 */
  conflictsWith?: string[];
  replayStepType?: string;
}

// ---------------------------------------------------------------------------
// 项目与案例包
// ---------------------------------------------------------------------------

export interface ProjectManifest {
  projectId: string;
  name: string;
  schemaVersion: string;
  domain: 'gel-electrophoresis';
  createdAt: string;
  description: string;
}

export interface Project {
  manifest: ProjectManifest;
  defaultBranch: string;
  branchHeads: Record<string, string>; // branchId -> eventId
  materials: Record<string, Material>;
  results: Record<string, ComputationResult>;
  events: EventNode[];
  /** sha256 -> 包内路径（原始图像字节等）。 */
  blobs: Record<string, string>;
  paramsVersion: string;
}

export type ReplayExpectedOutcome =
  | 'ok'
  | 'localized-invalidation'
  | 'candidate-set'
  | 'interval'
  | 'diagnostic-error'
  | 'budget-exhausted'
  | 'format-corrupt'
  | 'semantic-no-solution'
  | 'conflict';

export interface ReplayStep {
  id: string;
  title: string;
  type:
    | 'import'
    | 'auto-detect'
    | 'rotate'
    | 'curve-lanes'
    | 'ladder-missing-band'
    | 'saturate'
    | 'overlap-two-bands'
    | 'non-monotonic-ruler'
    | 'revise-params'
    | 'local-source-edit'
    | 'conflicting-decision'
    | 'post-revision-local-failure';
  branch?: string;
  description: string;
  expected: {
    outcome: ReplayExpectedOutcome;
    /** 影响必须被限制在的对象 id 前缀集合；其外对象不得失效。 */
    affectedScope: string[];
    diagnosticCodes: DiagnosticCode[];
  };
}

export interface CasePack {
  caseId: string;
  title: string;
  domain: 'gel-electrophoresis';
  version: string;
  createdAt: string;
  narrative: string;
  baseline: {
    rawImage: string; // blob sha256
    orientation: OrientationFact;
    exposure: ExposureFact;
    ladderSpecId: string;
    laneGeometryIds: string[];
    bandObsIds: string[];
  };
  replay: ReplayStep[];
  /** 初始项目（已含基线材料、自动候选与基线结果）。 */
  project: Project;
}
