/**
 * 胶道标尺工作台 —— 共享类型定义（服务端 / 存储层 / 界面共同使用）
 *
 * 分层原则：
 *  1. Material  不可变原始材料（原图、拍摄方向、曝光、ladder 标称值、lane 边界、band 中心）
 *               保留像素级来源与原始表示，永不就地修改。
 *  2. Event     追加式决定日志（自动候选、人工接受/否定/修订、源数据改动、参数修订）。
 *  3. Result    派生计算结果，内容寻址（输入摘要 + 参数版本 + 父级依赖），历史不被覆盖。
 */

export type ParameterSpace = 'log-linear' | 'piecewise-linear';

/** 带稳定身份的领域量。原始值保留原始表示；规范化值派生。 */
export interface QValue {
  value: number;
  unit: string;
  /** 导入时的原始表示（字符串/数字原样），不做规范化也不丢失 */
  raw?: string;
}

/** 像素坐标基准：所有像素级来源必须声明帧与朝向 */
export interface CoordFrame {
  /** 该坐标所依据的图像材质 id */
  imageId: string;
  widthPx: number;
  heightPx: number;
  /** 拍摄方向修正：0|90|180|270 度顺时针；像素坐标属于修正前帧时记为 'raw' */
  rotationDeg: 0 | 90 | 180 | 270;
  frame: 'raw' | 'corrected';
}

export interface PixelPoint {
  x: number;
  y: number;
  /** 像素级来源：自动检测 / 人工修订，以及操作者、时间 */
  provenance: Provenance;
}

export interface Provenance {
  kind: 'auto-candidate' | 'manual-revision' | 'imported';
  actor: string;
  at: string; // ISO8601
  /** 若是修订，指向被取代的几何来源 */
  supersedesPoint?: { x: number; y: number };
}

// ---------------------------------------------------------------------------
// 第一层：不可变材料（修正即“追加新版本”，旧版保留）
// ---------------------------------------------------------------------------

export type MaterialType =
  | 'image'
  | 'orientation'
  | 'exposure'
  | 'ladder'
  | 'lane-geometry'
  | 'band-centers';

export interface BaseMaterial {
  id: string;
  type: MaterialType;
  projectId: string;
  version: number;
  /** 该版本的产生事件 */
  originEventId: string | null;
  createdAt: string;
}

export interface ImageMaterial extends BaseMaterial {
  type: 'image';
  /** PNG 字节的内容寻址 sha256 */
  blobSha256: string;
  width: number;
  height: number;
  /** 像素强度约定：电泳图通常为暗背景亮带(dark-bg)或亮背景暗带(light-bg) */
  intensityConvention: 'dark-bg' | 'light-bg';
  /** 图像本身的旋转（仅图像源改动场景使用；默认 0） */
  rotationDeg: 0 | 90 | 180 | 270;
  originalName: string;
}

export interface OrientationMaterial extends BaseMaterial {
  type: 'orientation';
  rotationDeg: 0 | 90 | 180 | 270;
  rawRepresentation: string;
}

export interface ExposureMaterial extends BaseMaterial {
  type: 'exposure';
  exposureMs: QValue;
  bitDepth: number;
  gainRaw: string | null;
  /** 饱和判定阈值（原始灰度尺度） */
  saturationLevel: number;
}

export interface LadderBandNominal {
  /** 标称分子量，单位 bp（核酸）或 kDa（蛋白） */
  mw: QValue;
  ordinal: number;
}

export interface LadderMaterial extends BaseMaterial {
  type: 'ladder';
  laneOrdinal: number;
  unit: string;
  bands: LadderBandNominal[];
  rawRepresentation: string;
}

export interface LaneBoundary {
  /** 弯曲泳道：边界为曲线控制点；直泳道为 2 点 */
  spine: PixelPoint[];
  halfWidthPx: number;
}

export interface LaneGeometryMaterial extends BaseMaterial {
  type: 'lane-geometry';
  lanes: {
    ordinal: number;
    leftBoundary: LaneBoundary;
    rightBoundary: LaneBoundary;
  }[];
  frame: CoordFrame;
}

export interface BandCenterRecord {
  laneOrdinal: number;
  center: PixelPoint;
  /** 原始强度（灰度值，按曝光位深尺度） */
  intensityRaw: number;
}

export interface BandCentersMaterial extends BaseMaterial {
  type: 'band-centers';
  bands: BandCenterRecord[];
  frame: CoordFrame;
}

export type Material =
  | ImageMaterial
  | OrientationMaterial
  | LaneGeometryMaterial
  | BandCentersMaterial
  | ExposureMaterial
  | LadderMaterial;

// ---------------------------------------------------------------------------
// 第二层：追加式事件 / 决定
// ---------------------------------------------------------------------------

export type EventType =
  | 'project-created'
  | 'materials-imported'
  | 'auto-detected'
  | 'decision'
  | 'parameter-revision'
  | 'source-mutation'
  | 'scenario-triggered';

export type DecisionKind = 'accept' | 'reject' | 'revise' | 'conflict';

export interface CalibrationParams {
  model: ParameterSpace;
  saturationLevel: number | null;
  /** 两个峰被视为重叠的最小中心距(px) */
  overlapDistancePx: number;
  /** 标尺局部有效区域外推余量(px) */
  extrapolationMarginPx: number;
  peakProminence: number;
}

export interface WorkflowEvent {
  id: string;
  projectId: string;
  branch: string;
  seq: number;
  parentId: string | null;
  type: EventType;
  at: string;
  actor: string;
  message: string;
  payload: unknown;
}

// ---------------------------------------------------------------------------
// 第三层：派生结果（内容寻址）
// ---------------------------------------------------------------------------

export type ResultKind =
  | 'lane-profile'
  | 'band-candidates'
  | 'ruler-calibration'
  | 'mw-estimate';

export interface DependencyRef {
  kind: 'material' | 'result' | 'params';
  id: string;
  version: number | null;
  /** 输入摘要：材料内容 sha256 或结果 id */
  digest: string;
}

export interface Finding {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  subject: { kind: string; id: string; ordinal?: number } | null;
  at?: { x: number; y: number; frameImageId?: string };
  /** 有效区间（迁移距离单位 px） */
  validRange?: { minPx: number; maxPx: number };
  data?: Record<string, unknown>;
}

export type OutcomeStatus =
  | 'ok'
  | 'candidate'
  | 'ambiguous'
  | 'diagnostic-incomplete'
  | 'resource-exhausted'
  | 'corrupt-format'
  | 'semantically-unsolvable';

export interface ProfilePoint {
  /** 沿泳道脊线的弧长坐标(px) */
  s: number;
  x: number;
  y: number;
  /** 背景校正后的强度 */
  intensity: number;
}

export interface LaneProfileResult {
  kind: 'lane-profile';
  laneOrdinal: number;
  points: ProfilePoint[];
  findings: Finding[];
}

export interface BandCandidate {
  id: string;
  laneOrdinal: number;
  centerX: number;
  centerY: number;
  sPx: number;
  /** 半高位置对应的迁移距离区间（拖尾/饱和时退化为区间解的依据） */
  sHalfLowPx: number;
  sHalfHighPx: number;
  widthHalfPx: number;
  peakIntensity: number;
  saturated: boolean;
  tailing: boolean;
  overlapGroup: string | null;
  status: 'candidate' | 'accepted' | 'rejected' | 'revised' | 'interval';
}

export interface BandCandidatesResult {
  kind: 'band-candidates';
  candidates: BandCandidate[];
  findings: Finding[];
}

export interface RulerKnot {
  ordinal: number;
  nominalMw: number;
  unit: string;
  sPx: number;
  x: number;
  y: number;
  missing: boolean;
}

export interface RulerSegment {
  id: string;
  fromOrdinal: number;
  toOrdinal: number;
  sMinPx: number;
  sMaxPx: number;
}

export interface RulerCalibrationResult {
  kind: 'ruler-calibration';
  laneOrdinal: number;
  model: ParameterSpace;
  knots: RulerKnot[];
  segments: RulerSegment[];
  validRange: { minPx: number; maxPx: number };
  residuals: { ordinal: number; residualLogMw: number }[];
  nonMonotonic: boolean;
  findings: Finding[];
}

export interface MwEstimate {
  candidateId: string;
  laneOrdinal: number;
  mw: QValue | null;
  interval: { low: QValue; high: QValue } | null;
  sPx: number;
  bracket: { fromOrdinal: number; toOrdinal: number; segmentId: string } | null;
  withinValidRange: boolean;
  status: BandCandidate['status'] | 'out-of-range';
}

export interface MwEstimateResult {
  kind: 'mw-estimate';
  laneOrdinal: number;
  estimates: MwEstimate[];
  findings: Finding[];
}

export interface DerivedResult {
  id: string;
  projectId: string;
  branch: string;
  kind: ResultKind;
  laneOrdinal: number | null;
  paramsVersion: number;
  dependencies: DependencyRef[];
  inputDigest: string;
  status: OutcomeStatus;
  data:
    | LaneProfileResult
    | BandCandidatesResult
    | RulerCalibrationResult
    | MwEstimateResult;
  findings: Finding[];
  createdAt: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  path: string;
  at?: { x?: number; y?: number; ordinal?: number; lane?: number };
  severity: 'error' | 'warning';
}

export const PARAMS_VERSION = 1;

export const DEFAULT_PARAMS: CalibrationParams = {
  model: 'log-linear',
  saturationLevel: null,
  overlapDistancePx: 14,
  extrapolationMarginPx: 4,
  peakProminence: 18
};
