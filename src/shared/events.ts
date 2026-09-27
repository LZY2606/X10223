import type { CoordinateBasis, Point, Quantity, SourcedPoint } from './units.js';

/** 参数/规则版本。任何派生事件都记录所用参数版本。 */
export interface ParamVersion {
  profile: string;
  version: string;
}

export interface InputDigest {
  /** 参与计算的直接输入（稳定身份）列表 */
  inputs: string[];
  /** 这些输入内容的汇总哈希 */
  digest: string;
}

export type Severity = 'info' | 'warning' | 'error';

/** 带位置的诊断：输入不完整时返回位置，不用空值伪装成功 */
export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  /** 对象坐标或材料内位置 */
  at?: { laneId?: string; bandId?: string; point?: Point; segmentIndex?: number };
  message: string;
}

export type DiagnosticCode =
  | 'INCOMPLETE_INPUT'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNSOLVABLE'
  | 'BUDGET_EXHAUSTED'
  | 'ROTATION_MIGRATION_AXIS'
  | 'LADDER_MISSING_BAND'
  | 'NON_MONOTONIC_RULER'
  | 'SATURATED_BAND'
  | 'TAILING_BAND'
  | 'OVERLAPPING_BANDS'
  | 'SMILE_CURVATURE'
  | 'RULER_OUT_OF_VALID_REGION'
  | 'LOCAL_RULER_INVALIDATED'
  | 'CONFLICTING_DECISIONS'
  | 'PAIRING_AMBIGUOUS';

/** 计算结果的三态：成功 / 候选或区间 / 三种截然不同的失败 */
export type OutcomeKind =
  | 'OK'
  | 'CANDIDATE'          // 无法唯一决定，保留全部合法候选
  | 'INTERVAL'           // 只能给区间
  | 'BUDGET_EXHAUSTED'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNSOLVABLE';

// ---------------------------------------------------------------------------
// 不可变材料（immutable materials）：导入后永不就地修改，修订 = 新事件指向新材料
// ---------------------------------------------------------------------------

export type OrientationMode = 'canonical' | 'rotate-90' | 'rotate-180' | 'rotate-270';

export interface ImageMaterial {
  id: string;
  kind: 'image';
  width: number;
  height: number;
  /** 单通道 8bit 灰度像素，长度 width*height，行优先 */
  raster: Uint8Array;
  sha256: string;
  createdAt: string;
  sourceName: string;
}

export interface FrameMaterial {
  id: string;
  kind: 'frame';
  imageId: string;
  parentFrameId?: string;
  orientation: OrientationMode;
  /** 帧相对原图的像素变换（旋转后坐标映射用） */
  width: number;
  height: number;
  basis: CoordinateBasis;
}

export interface ExposureMaterial {
  id: string;
  kind: 'exposure';
  imageId: string;
  exposureTime?: Quantity; // ms
  gain?: Quantity;         // ratio
  isOverexposed: boolean;
  /** 饱和阈值（8bit），像素 >= 该值记为饱和 */
  saturationLevel: number;
}

export interface LadderNominal {
  /** 标称分子量 */
  mw: Quantity;
  /** 该标称值在原文中的 token 位置（保留来源） */
  rawIndex: number;
  raw: string;
}

export interface LadderMaterial {
  id: string;
  kind: 'ladder-nominals';
  imageId: string;
  laneId?: string;
  /** 标称值按声明顺序保留原始表示 */
  nominals: LadderNominal[];
  monotonic: boolean;
}

export type LaneBoundarySource = 'auto' | 'manual';

export interface LaneMaterial {
  id: string;
  kind: 'lane';
  imageId: string;
  frameId: string;
  laneIndex: number;
  source: LaneBoundarySource;
  /** 泳道中心线：贝塞尔样条控制点（像素级来源，SourcedPoint） */
  centerline: SourcedPoint[];
  /** 半宽（像素，随弧长给出） */
  halfWidth: number[];
  /** 弯曲程度：中心线对直线的最大法向偏离像素 */
  curvaturePx: number;
}

export interface BandMaterial {
  id: string;
  kind: 'band';
  imageId: string;
  frameId: string;
  laneId: string;
  source: 'auto' | 'manual';
  /** 条带在泳道中心线上的弧长位置（像素，绑定帧） */
  arcPx: number;
  center: SourcedPoint;
  /** 沿迁移轴的高斯 sigma（像素） */
  spreadPx: number;
  saturated: boolean;
  tailing: boolean;
  peakIntensity: number;
}

// ---------------------------------------------------------------------------
// 派生层（derived）：记录输入摘要、参数版本、父级依赖
// ---------------------------------------------------------------------------

export interface LadderAssignment {
  bandId: string;
  nominalRawIndex: number;
  /** 配对置信度；歧义时产生多个候选 assignment */
  confidence: number;
}

export interface CalibrationResult {
  id: string;
  kind: 'calibration';
  laneId: string;
  ladderId: string;
  frameId: string;
  assignments: LadderAssignment[];
  /** 每段：弧长 px -> log10(bp)，仅在相邻已配对点之间有效 */
  segments: RulerSegment[];
  validArcRange: { min: number; max: number };
  outcome: OutcomeKind;
  diagnostics: Diagnostic[];
  paramVersion: ParamVersion;
  inputDigest: InputDigest;
}

export interface RulerSegment {
  index: number;
  arcFrom: number;
  arcTo: number;
  logMwFrom: number;
  logMwTo: number;
  /** 该段来自哪两个 ladder 点（稳定身份） */
  fromBandId: string;
  toBandId: string;
  monotonic: boolean;
}

export interface MwInference {
  id: string;
  kind: 'mw-inference';
  bandId: string;
  laneId: string;
  calibrationId: string;
  segmentIndex: number;
  /** 主估值（bp）。候选/区间时可能为 NaN */
  mwBp: number;
  /** 区间（bp），饱和/拖尾/重叠时使用 */
  interval?: { lowBp: number; highBp: number };
  candidatesBp?: number[];
  outcome: OutcomeKind;
  diagnostics: Diagnostic[];
  paramVersion: ParamVersion;
  inputDigest: InputDigest;
}

// ---------------------------------------------------------------------------
// 事件（append-only，内容寻址）。回到任意旧事件恢复当时依赖与结论
// ---------------------------------------------------------------------------

export type EventType =
  | 'PROJECT_CREATED'
  | 'IMAGE_IMPORTED'
  | 'FRAME_SET'
  | 'EXPOSURE_SET'
  | 'LADDER_SET'
  | 'LANE_SET'
  | 'BAND_SET'
  | 'DETECTION_RUN'
  | 'CALIBRATION_COMPUTED'
  | 'MW_INFERRED'
  | 'DECISION'
  | 'LOCAL_INVALIDATION'
  | 'BRATCH_CREATED'
  | 'BRANCH_POINTER';

export type DecisionValue = 'accept' | 'reject' | 'adjust';

export interface Event<T = unknown> {
  id: string;
  projectId: string;
  seq: number;
  /** DAG 父事件：分支/修订的历史边，顺序稳定 */
  parents: string[];
  type: EventType;
  /** ISO 时间基准 */
  at: string;
  branch: string;
  payload: T;
  /** 参与事件的材料/结果稳定身份 */
  refs: string[];
}
