// 领域核心类型：不可变材料 / 派生计算 / 决定事件三层分离。
// 所有领域量都携带单位或坐标基准；成功结果中禁止 null 伪装。

export type Unit =
  | 'px' // 校正后图像像素
  | 'px-raw' // 原始拍摄像素（未经旋转/翻转）
  | 'deg'
  | 's'
  | 'ms'
  | 'Da'
  | 'kDa'
  | 'bp'
  | 'count'
  | 'gray16'
  | 'arc-length-px'
  | 'pixel-intensity';

/** 已成功解析的带单位量。value 必须是有限数。 */
export interface Quantity {
  value: number;
  unit: Unit;
  /** 坐标/数值基准说明，例如 "capture#cap_v1 原始像素坐标系" */
  basis: string;
}

/** 导入时保留的原始表示；派生层才做规范化。 */
export interface RawValue {
  text: string;
  declaredUnit?: string;
  /** 无法转换时诊断留在原地 */
  diagnostic?: Diagnostic;
}

export type DiagnosticCode =
  | 'INCOMPLETE_INPUT'
  | 'UNCONVERTIBLE_UNIT'
  | 'MISSING_LADDER_BAND'
  | 'NON_MONOTONIC_RULER'
  | 'OUTSIDE_VALID_REGION'
  | 'SATURATED_BAND'
  | 'SMEARED_BAND'
  | 'OVERLAPPING_BANDS'
  | 'ORIENTATION_SUSPECT'
  | 'BAND_AMBIGUOUS'
  | 'LOCAL_INVALIDATED'
  | 'BUDGET_EXHAUSTED'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNRESOLVABLE'
  | 'CHECKSUM_MISMATCH'
  | 'DEPENDENCY_MISSING';

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  /** 带位置的诊断：对象 id / 像素坐标 / 字节偏移 */
  at?: {
    objectId?: string;
    point?: PixelPoint;
    byteOffset?: number;
    segmentId?: string;
    laneId?: string;
  };
  severity: 'error' | 'warning' | 'info';
}

/** 坐标点：始终声明所用图像版本、坐标系与变换链。 */
export interface PixelPoint {
  x: number;
  y: number;
  unit: 'px' | 'px-raw';
  imageVersionId: string;
  /** 从原始像素到该点应用过的变换 id 顺序 */
  transformChain: string[];
  basis: 'human-annotation' | 'auto-candidate' | 'synthetic-truth' | 'derived';
}

export interface Transform {
  id: string;
  kind: 'rotate' | 'flip-h' | 'flip-v';
  angleDeg?: Quantity;
  /** 直接来源：该变换由哪条材料/决定给出 */
  source: string;
}

export interface ExposureInfo {
  exposureTime: RawValue | Quantity;
  bitDepth: number;
  maxSensorValue: number; // 例如 16 位 65535
  sensorResponse: 'linear' | 'unspecified';
  saturationThreshold: number; // 达到该灰度比例视为饱和（如 0.99）
  sourceNote: string;
}

export interface OrientationInfo {
  /** 原始拍摄相对标准方向（上=点样孔）的顺时针旋转角 */
  rotationDeg: Quantity;
  flipH: boolean;
  flipV: boolean;
  declaredBy: 'capture-manifest' | 'human';
}

/** 不可变材料层 */
export type Material =
  | CaptureMaterial
  | LadderNominalMaterial
  | AnnotationMaterial;

export interface MaterialBase {
  id: string;
  projectId: string;
  kind: MaterialKind;
  /** 同一直接来源的新版本指向前一版本；旧版本永不被覆盖 */
  versionOf?: string;
  createdAt: string;
  origin: 'import' | 'human-revision' | 'case-mutation' | 'seed';
  checksum: string;
}

export type MaterialKind = 'capture' | 'ladder-nominal' | 'annotation';

export interface CaptureMaterial extends MaterialBase {
  kind: 'capture';
  width: number;
  height: number;
  /** 16 位灰度，长度 width*height；存于材料 blob 存储 */
  blobRef: string;
  orientation: OrientationInfo;
  exposure: ExposureInfo;
  rawManifest: Record<string, unknown>;
}

export interface LadderBandNominal {
  nominalId: string;
  /** 标称分子量，保留导入原文；converted 在派生层填充 */
  mw: RawValue;
  /** 点样孔向下序号，1 为最大分子量 */
  rank: number;
}

export interface LadderNominalMaterial extends MaterialBase {
  kind: 'ladder-nominal';
  ladderName: string;
  bands: LadderBandNominal[];
  mwUnitExpected: 'Da' | 'kDa' | 'bp';
}

export interface LaneAnnotation {
  laneId: string;
  /** 车道边界折线（左右各一条），点为像素级来源 */
  leftBoundary: PixelPoint[];
  rightBoundary: PixelPoint[];
  /** 车道中心折线（可弯曲），派生层可用，但人工值留痕 */
  centerline?: PixelPoint[];
  role: 'ladder' | 'sample';
  label?: string;
}

export interface BandAnnotation {
  bandId: string;
  laneId: string;
  /** 人工标注的条带中心（像素级） */
  center: PixelPoint;
  /** 若该带被人工指定为 ladder 某标称带 */
  ladderNominalId?: string;
  note?: string;
}

export interface AnnotationMaterial extends MaterialBase {
  kind: 'annotation';
  lanes: LaneAnnotation[];
  bands: BandAnnotation[];
  author: string;
}

/** 规则/参数版本 */
export interface RuleVersion {
  id: string;
  family: 'detection' | 'calibration';
  version: number;
  params: Record<string, number | string | boolean>;
  note: string;
  createdAt: string;
}

/** 计算结果输入摘要：显式父级依赖，缺一即失败诊断 */
export interface ComputationInputSummary {
  materials: Record<MaterialKind, string | undefined>;
  rules: { detection: string; calibration: string };
  upstreamComputations: string[];
}

export type ComputationStatus = 'ok' | 'warning' | 'failed';

export interface DerivedLane {
  laneId: string;
  role: 'ladder' | 'sample';
  label: string;
  /** 检测/合并后的中心折线（校正图像坐标，像素级，basis=auto） */
  centerline: PixelPoint[];
  leftBoundary: PixelPoint[];
  rightBoundary: PixelPoint[];
  arcLength: Quantity;
  quality: number;
}

export interface DerivedBand {
  bandId: string;
  laneId: string;
  center: PixelPoint;
  /** 沿车道折线的弧长迁移坐标 */
  migration: Quantity;
  /** 横向偏离中心线（px） */
  lateralOffset: Quantity;
  peakIntensity: Quantity;
  width: Quantity;
  flatTop: boolean;
  saturated: boolean;
  smeared: boolean;
  /** 与邻近带轮廓重叠（未分离） */
  overlapsWith: string[];
}

export interface LadderMatch {
  matchId: string;
  nominalId: string;
  nominalMw: Quantity;
  point: PixelPoint;
  migration: Quantity;
  detectedBandId?: string;
  /** 缺带时无检测点，仅保留标称位序号 */
  missing: boolean;
}

export interface CalibrationSegment {
  segmentId: string;
  fromMatchId: string;
  toMatchId: string;
  migrationLo: Quantity;
  migrationHi: Quantity;
  mwLo: Quantity;
  mwHi: Quantity;
  interpolation: 'log10(mw)-linear';
  valid: boolean;
  invalidReason?: DiagnosticCode;
  /** 局部有效区域：弧长区间 + 横向半宽 + 适用车道范围 */
  validRegion: {
    migrationMin: Quantity;
    migrationMax: Quantity;
    lateralHalfWidth: Quantity;
    laneIdMin: string;
    laneIdMax: string;
  };
}

export interface CalibrationRuler {
  rulerId: string;
  ladderLaneId: string;
  matches: LadderMatch[];
  segments: CalibrationSegment[];
  /** 标尺整体有效弧长区间（首个—末个有效匹配） */
  validMigration: { min: Quantity; max: Quantity } | undefined;
  monotonic: boolean;
  diagnostics: Diagnostic[];
}

export interface MwInference {
  inferenceId: string;
  bandId: string;
  laneId: string;
  decision: 'unique' | 'interval' | 'candidate-set' | 'indeterminate';
  unique?: Quantity;
  interval?: { lo: Quantity; hi: Quantity };
  candidates?: Quantity[];
  usedSegmentIds: string[];
  rulerId: string;
  status: ComputationStatus;
  diagnostics: Diagnostic[];
  /** 与自动候选并列时的人工修订标记 */
  source: 'auto-candidate' | 'human-revised';
}

export interface FittingResidual {
  objectId: string;
  point: PixelPoint;
  observed: Quantity;
  predicted: Quantity;
  residual: Quantity;
}

export type ComputedArtifactKind =
  | 'lane-detection'
  | 'band-detection'
  | 'ladder-calibration'
  | 'mw-inference';

export interface Computation {
  id: string;
  projectId: string;
  kind: ComputedArtifactKind;
  status: ComputationStatus;
  inputSummary: ComputationInputSummary;
  ruleVersionId: string;
  /** 内容寻址：相同输入+规则 => 相同 id */
  parents: string[];
  diagnostics: Diagnostic[];
  artifacts: unknown;
  residual?: FittingResidual[];
  computedAt: string;
}

/** 事件：机器可读取，接受/否定/修订/参数调整/冲突均生成新事件 */
export type EventKind =
  | 'PROJECT_CREATED'
  | 'MATERIAL_VERSIONED'
  | 'AUTO_CANDIDATES_COMPUTED'
  | 'CANDIDATE_ACCEPTED'
  | 'CANDIDATE_REJECTED'
  | 'BAND_REVISED'
  | 'LANE_REVISED'
  | 'LADDER_ASSIGNMENT_REVISED'
  | 'PARAM_ADJUSTED'
  | 'CONFLICTING_DECISION'
  | 'LOCAL_INVALIDATION'
  | 'EXPORTED'
  | 'IMPORTED'
  | 'BUDGET_EXHAUSTED'
  | 'SEMANTIC_BLOCK';

export interface ProjectEvent {
  id: string;
  projectId: string;
  seq: number;
  kind: EventKind;
  parentEventId: string | null;
  branch: string;
  timestamp: string;
  actor: 'auto' | 'reviewer' | 'system';
  payload: Record<string, unknown>;
  /** 该事件影响到的对象（限制影响范围的证据） */
  affectedObjectIds: string[];
  /** 事件发生时 head 计算图各层版本，供回溯 */
  graphRef: {
    materials: string[];
    rules: string[];
    computations: string[];
    head: string | null;
  };
}

export interface Project {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  headEventId: string | null;
  branches: Record<string, string>;
}

/** 资源预算 */
export interface Budget {
  maxPixels: number;
  maxComputations: number;
  maxEvents: number;
}

export type FailureResult =
  | { kind: 'budget-exhausted'; budget: Budget; used: { pixels: number; computations: number }; retryable: true; message: string }
  | { kind: 'format-corrupt'; message: string; byteOffset?: number; path?: string; expected?: string }
  | { kind: 'semantic-unresolvable'; message: string; unresolved: { objectId: string; reason: string; legalCandidates?: string[] }[] };
