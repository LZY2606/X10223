/**
 * 胶道标尺工作台领域类型。
 * 分层原则：
 *  1) 不可变材料层 materials：原图、拍摄方向、曝光、ladder 标称值、lane 边界、band 中心，
 *     全部保留像素级来源（imageId + 像素坐标 + 原始表示 + origin）。
 *  2) 可修改决定层 events：接受/否定/参数调整/修订，以追加事件表达，永不覆盖历史。
 *  3) 派生层 derivations：分子量推断、局部标尺、拟合残差，带输入摘要、参数版本、父级依赖与稳定身份。
 */

export type ParameterSpace = 'image_pixels';
export type LengthUnit = 'px';
export type MassUnit = 'bp' | 'kDa';

export interface Point {
  x: number; // 图像像素坐标（以对应 imageId 的左上角为原点）
  y: number;
  unit: LengthUnit;
}

export interface PixelSource {
  imageId: string;
  /** 该像素来源依赖的拍摄方向事件；方向改变后旧像素来源会被 STALE_COORDINATE_BASIS 诊断标记。 */
  orientationVersion: string;
  /** 原始表示（导入时保留，不做单位换算）。 */
  raw?: { text?: string; coords?: { x: number; y: number }[] };
  origin: 'auto_candidate' | 'manual' | 'seed';
  note?: string;
}

export type OrientationDeg = 0 | 90 | 180 | 270;

export interface ExposureInfo {
  exposureMs: number; // 毫秒，时间基准显式
  sensorBits: number; // 传感器位深（如 12）
  saturationLevel: number; // 饱和阈值（以像素值计，如 4095/255）
  gain?: number;
  sourceText?: string; // 原始表示
}

export type ImageVariant =
  | 'baseline'
  | 'rotated_180'
  | 'smile_lanes'
  | 'saturated'
  | 'overlapping';

export interface GelImage {
  id: string;
  width: number;
  height: number;
  channels: 1 | 3;
  contentType: 'image/png';
  blobSha256: string;
  variant: ImageVariant;
  exposure: ExposureInfo;
  importTime: string; // ISO8601 时间基准
}

export interface LadderBandNominal {
  id: string;
  laneId: string;
  center: Point;
  nominal: number; // 标称分子量
  unit: MassUnit;
  /** true 表示该梯道带在本次材料中缺失（ladder 缺带），不参与标定但保留位置与诊断。 */
  missing?: boolean;
  source: PixelSource;
}

export type LaneShapeKind = 'straight' | 'smile' | 'frown';

export interface Lane {
  id: string;
  imageId: string;
  /** 泳道中心曲线控制点（像素）。弯曲时曲线为二次贝塞尔近似。 */
  centerline: Point[];
  widthPx: number; // 泳道宽度（像素），边界 = 中心线 ± width/2
  shape: LaneShapeKind;
  isLadder?: boolean;
  label: string;
  source: PixelSource;
}

export interface Band {
  id: string;
  laneId: string;
  imageId: string;
  center: Point;
  /** 沿泳道曲线的弧长（像素），派生自 center + lane 几何。 */
  arcLengthPx?: number;
  status:
    | 'resolved'
    | 'saturated'
    | 'smeared'
    | 'overlapped'
    | 'candidate';
  /** 饱和/拖尾/重叠时给出的像素级证据区间（沿弧长，单位 px），只能得候选或区间。 */
  interval?: { start: number; end: number; unit: LengthUnit };
  peakIntensity?: number; // 0..1
  source: PixelSource;
}

export type EventType =
  | 'project_created'
  | 'image_imported'
  | 'orientation_amended'
  | 'exposure_set'
  | 'ladder_lane_assigned'
  | 'ladder_band_nominated'
  | 'ladder_band_marked_missing'
  | 'lane_added'
  | 'lane_revised'
  | 'band_detected'
  | 'band_center_revised'
  | 'parameters_revised'
  | 'inference_recorded'
  | 'decision_recorded'
  | 'source_amended'
  | 'impact_diagnostic'
  | 'archive_note';

export type DecisionVerdict = 'accepted' | 'rejected';

export interface CalibrationParameters {
  /** 分子量模型：分段线性 log(MW) 对弧长 s 插值。 */
  model: 'piecewise_linear_log_mw';
  version: number;
  /** 梯道段两端外的合法外推余量（像素）；超出则 OUTSIDE_VALID_RANGE/EXTENDED_SEGMENT。 */
  extrapolationMarginPx: number;
  /** 饱和判定阈值（0..1 相对强度）。 */
  saturationRatio: number;
  /** 重叠判定阈值（弧长像素）。 */
  overlapGapPx: number;
  /** 单次推断允许的最大弧段评估数（资源预算）。 */
  maxSegmentEvaluations: number;
}

export const DEFAULT_PARAMETERS: CalibrationParameters = {
  model: 'piecewise_linear_log_mw',
  version: 1,
  extrapolationMarginPx: 18,
  saturationRatio: 0.985,
  overlapGapPx: 6,
  maxSegmentEvaluations: 200_000,
};

export type GelErrorCode = import('./errors.ts').GelErrorCode;

export interface Diagnostic {
  code: GelErrorCode;
  message: string;
  position?: import('./errors.ts').DiagnosticPosition;
  affectedObjectIds: string[];
}

export interface CalibrationSegment {
  id: string;
  ladderBandA: string;
  ladderBandB: string;
  /** 局部标尺有效弧长区域 [start,end]（像素），微笑弯曲时同高度≠同分子量，必须带有效区域。 */
  validRange: { start: number; end: number; unit: LengthUnit };
  slope: number; // d log(MW) / d s(px)
  intercept: number;
  residual: number; // 该段拟合残差（log MW 单位）
  status: 'valid' | 'extended' | 'invalid';
}

export interface InferenceResult {
  id: string; // 稳定派生身份
  bandId: string;
  laneId: string;
  values: MassCandidate[]; // 无法唯一决定时保留全部合法候选
  range?: { low: number; high: number; unit: MassUnit };
  segmentId: string | null; // 点击分子量回到的插值段
  ladderPointIds: string[]; // 点击分子量回到的 ladder 点
  unit: MassUnit;
  diagnostics: Diagnostic[];
  outcome: 'unique' | 'candidate_set' | 'interval' | 'incomplete' | 'no_solution' | 'budget_exhausted';
  provenance: DerivationProvenance;
}

export interface MassCandidate {
  mass: number;
  unit: MassUnit;
  status: 'precise' | 'candidate' | 'bounded';
  basis: 'segment_interpolation' | 'extended_segment' | 'saturation_bounds' | 'overlap_set';
  segmentId?: string;
}

export interface DerivationProvenance {
  inputSummary: string; // 输入摘要 sha256(canonical inputs)
  parametersVersion: number;
  parents: string[]; // 父级依赖（事件/材料/派生 id）
  formula: CalibrationParameters['model'];
}

export interface Decision {
  targetResultId: string;
  verdict: DecisionVerdict;
  reason?: string;
}

export type EventPayloadMap = {
  project_created: { name: string; unit: MassUnit };
  image_imported: { image: GelImage };
  orientation_amended: { imageId: string; fromDeg: OrientationDeg; toDeg: OrientationDeg };
  exposure_set: { imageId: string; exposure: ExposureInfo };
  ladder_lane_assigned: { laneId: string };
  ladder_band_nominated: { band: LadderBandNominal };
  ladder_band_marked_missing: { ladderBandId: string; missing: boolean };
  lane_added: { lane: Lane };
  lane_revised: { lane: Lane; supersedes: string };
  band_detected: { bands: Band[] };
  band_center_revised: { band: Band; supersedes: string };
  parameters_revised: { fromVersion: number; toVersion: number; changes: Partial<Record<keyof CalibrationParameters, number>> };
  inference_recorded: { imageId: string; results: InferenceResult[] };
  decision_recorded: Decision;
  source_amended: { imageId: string; fromVariant: ImageVariant; toVariant: ImageVariant; note: string; changedDirectSource: string };
  impact_diagnostic: { triggerEventId: string; diagnostics: Diagnostic[]; branchOnly?: boolean };
  archive_note: { text: string };
};

export interface GelEvent<T extends EventType = EventType> {
  id: string;
  projectId: string;
  seq: number; // 项目内稳定顺序（追加），等价输入重放得到稳定顺序
  branch: string; // 分支 id，主分支为 'main'
  parentEventId: string | null;
  forkedFromEventId?: string;
  type: T;
  payload: EventPayloadMap[T];
  /** 该事件自身的输入摘要（重放校验）。 */
  payloadSummary: string;
  time: string;
  actor: 'auto' | 'reviewer' | 'seed';
}

export interface CounterCaseScenario {
  id: string;
  title: string;
  directSourceChanged: string; // 只改动的那一个直接来源
  baselineEventId: string;
  branch: string;
  expectedDiagnostics: GelErrorCode[];
  expectedContainment: string[]; // 被影响对象 id（影响应被限制在此范围）
  adopted: boolean;
}

export interface ProjectBundle {
  format: 'gel-bench-bundle';
  formatVersion: 1;
  projectId: string;
  createdAt: string;
  blobs: { sha256: string; contentType: string; base64: string }[];
  events: GelEvent[];
  scenarios: CounterCaseScenario[];
  checksumSha256: string; // 对除 checksumSha256 外内容的摘要
}

export interface BranchView {
  branch: string;
  label: string;
  description: string;
  headEventId: string;
}
