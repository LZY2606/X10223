/**
 * 胶道标尺 —— 领域模型。
 *
 * 分层原则：
 *  1) 不可变材料层（image / orientation / exposure / ladderSpec / laneMap / bandMarks）
 *     —— 每个坐标都带像素级来源与坐标基准；导入保留原始表示（rawText/rawUnit）。
 *  2) 决定层（ruleParams / decision）——人工可修订，只追加不改写。
 *  3) 派生层（derivation）——自动候选、校准段、分子量推断；记录 inputSummary、
 *     参数版本（paramsId / rulesVersion）与父级依赖（parents），可完整重放。
 */

export type RuleVersion = 'rules-2026.09.0';

export const RULES_VERSION: RuleVersion = 'rules-2026.09.0';

/** 资源预算（RESOURCE_BUDGET 必须与损坏/无解可区分）。 */
export const BUDGETS = {
  maxPixels: 4_000_000,
  maxLanes: 64,
  maxBandsPerLane: 200,
  maxEvents: 200_000,
  maxImageBytes: 32 * 1024 * 1024
} as const;

export type CoordFrame = 'raw' | 'canonical';

export interface Point {
  x: number;
  y: number;
}

export interface SourcedPoint extends Point {
  frame: CoordFrame;
  /** 像素级来源：坐标从哪一版材料、以何种方式得到。 */
  source: PixelProvenance;
}

export interface PixelProvenance {
  materialId: string;
  /** auto = 算法候选；manual = 人工修订；imported = 原样导入。 */
  origin: 'auto' | 'manual' | 'imported';
  /** 原始表示（导入时不丢精度/不强行规范化）。 */
  raw?: string;
  method?: string;
  /** 该点所依赖的上游稳定身份（如方向版本、参数版本）。 */
  basedOn?: string[];
}

// ---------- 不可变材料 ----------

export interface ImageMaterial {
  kind: 'image';
  id: string;
  /** 原始字节哈希（稳定身份）。 */
  sha256: string;
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  byteLength: number;
  /** 原始表示：导入时的媒体类型、文件名（不规范化）。 */
  mediaType: string;
  originalName?: string;
  createdAt: string;
}

export interface OrientationMaterial {
  kind: 'orientation';
  id: string;
  imageId: string;
  /** 顺时针旋转角度（度），把 raw 坐标变到 canonical（迁移向下）。 */
  rotationDeg: 0 | 90 | 180 | 270;
  /** 原图 -> 规范帧是否需要水平/垂直翻转（拍摄方向核对）。 */
  flipH: boolean;
  flipV: boolean;
  provenance: PixelProvenance;
}

export interface ExposureMaterial {
  kind: 'exposure';
  id: string;
  imageId: string;
  /** 曝光时间，原始表示必须保留（带单位）。 */
  duration: PhysicalQuantity;
  /** 饱和判据（像素值 >= threshold 视为饱和），参数版本可修订阈值。 */
  intensityFloor: number;
  intensityCeiling: number;
  inverted: boolean;
  provenance: PixelProvenance;
}

export interface PhysicalQuantity {
  value: number | null;
  unit: string;
  /** 无法转换/解析时保留原始表示。 */
  rawText: string;
  /** 规范化单位（派生层使用），无法转换时为 null。 */
  canonicalUnit?: string;
}

export interface LadderBandNominal {
  index: number;
  /** 标称分子量，bp 或 kDa/kDalton 等，导入原样保留。 */
  mass: PhysicalQuantity;
  /** 该标称带是否在图上缺失（缺带反例）。 */
  present: boolean;
}

export interface LadderSpecMaterial {
  kind: 'ladderSpec';
  id: string;
  name: string;
  /** 核酸按 bp 单调递减；蛋白按 kDa，几何方向相反时由 orientation 归一。 */
  analyte: 'nucleic-acid' | 'protein';
  bands: LadderBandNominal[];
  provenance: PixelProvenance;
}

export interface LaneCurve {
  laneIndex: number;
  /** 沿泳道的中心线（canonical 像素），密集采样；弧长由此计算。 */
  centerline: SourcedPoint[];
  /** 左右边界曲线（像素级来源）。 */
  leftBoundary: SourcedPoint[];
  rightBoundary: SourcedPoint[];
}

export interface LaneMapMaterial {
  kind: 'laneMap';
  id: string;
  imageId: string;
  lanes: LaneCurve[];
  provenance: PixelProvenance;
}

export interface BandMark {
  id: string;
  laneIndex: number;
  /** 条带中心（像素级来源；原始与规范坐标都留痕）。 */
  center: SourcedPoint;
  rawCenter: SourcedPoint;
  /** 沿中心线的弧长 s（canonical，像素）；微笑弯曲时以 s 而非 y 比较。 */
  arcLength?: number;
  /** 峰值强度 [0,255]，饱和时 == ceiling。 */
  peakIntensity: number;
  saturated: boolean;
  widthPx: number;
  /** 拖尾/涂污标记。 */
  smear: boolean;
  provenance: PixelProvenance;
}

export interface BandMarksMaterial {
  kind: 'bandMarks';
  id: string;
  imageId: string;
  bands: BandMark[];
  provenance: PixelProvenance;
}

export type Material =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderSpecMaterial
  | LaneMapMaterial
  | BandMarksMaterial;

export type MaterialKind = Material['kind'];

// ---------- 决定层（可修订） ----------

export interface RuleParams {
  version: number;
  /** 饱和强度阈值（<= ceiling 才允许唯一值）。 */
  saturationThreshold: number;
  /** 两个峰中心小于该像素距离视为重叠。 */
  overlapDistancePx: number;
  /** 拖尾判定：半高宽相对基线宽度倍数。 */
  smearWidthRatio: number;
  /** 校准外推容差（弧长像素）；超出 -> OUT_OF_RANGE 区间。 */
  extrapolationTolerancePx: number;
  /** 缺带枚举候选上限，防止组合爆炸（资源预算）。 */
  maxMissingBands: number;
  /** 插值方法。 */
  method: 'pchip-log' | 'linear-log';
}

export const DEFAULT_RULE_PARAMS: RuleParams = {
  version: 1,
  saturationThreshold: 250,
  overlapDistancePx: 14,
  smearWidthRatio: 2.2,
  extrapolationTolerancePx: 8,
  maxMissingBands: 2,
  method: 'pchip-log'
};

export type DecisionVerb = 'accept' | 'reject' | 'adjust';

export interface Decision {
  kind: 'decision';
  id: string;
  parentId: string;
  timestamp: string;
  author: string;
  verb: DecisionVerb;
  /** 作用对象：候选条带 / 候选分子量 / 校准段。 */
  targetId: string;
  /** adjust 时的人工修订值（像素级来源 manual）。 */
  payload?: Record<string, unknown>;
  reason?: string;
}

// ---------- 事件溯源 ----------

export interface ProjectCreated {
  kind: 'projectCreated';
  id: string;
  parentId: null;
  timestamp: string;
  projectId: string;
  name: string;
}

export interface MaterialAdded {
  kind: 'materialAdded';
  id: string;
  parentId: string;
  timestamp: string;
  material: Material;
}

export interface MaterialAmended {
  kind: 'materialAmended';
  id: string;
  parentId: string;
  timestamp: string;
  /** 被替代的材料（仍在历史中，不删除）。 */
  supersedesId: string;
  material: Material;
}

export interface ParamsSet {
  kind: 'paramsSet';
  id: string;
  parentId: string;
  timestamp: string;
  params: RuleParams;
  paramsHash: string;
}

export interface DerivationRecorded {
  kind: 'derivationRecorded';
  id: string;
  parentId: string;
  timestamp: string;
  derivation: Derivation;
}

export type Event =
  | ProjectCreated
  | MaterialAdded
  | MaterialAmended
  | ParamsSet
  | Decision
  | DerivationRecorded;

export type EventKind = Event['kind'];

// ---------- 派生层 ----------

export type DerivationStatus = 'ok' | 'candidate' | 'range' | 'invalid';

export interface InputSummary {
  materials: Record<string, { kind: MaterialKind; sha256?: string; version: number }>;
  paramsHash: string;
  rulesVersion: RuleVersion;
  acceptedDecisionIds: string[];
}

export interface LadderCalibrationPoint {
  id: string;
  bandMarkId: string;
  nominalBandIndex: number;
  massBpOrKda: number | null;
  arcLength: number;
  residual: number;
  valid: boolean;
  diagnosticCodes: DiagnosticCodeLite[];
}

export interface CalibrationSegment {
  id: string;
  laneIndex: number;
  /** 弧长有效区域 [sMin, sMax]；局部标尺只在带有效区域的区间内成立。 */
  sMin: number;
  sMax: number;
  /** 有效区域对应的分子量窗口。 */
  massMin: number | null;
  massMax: number | null;
  pointIds: string[];
  monotonic: boolean;
}

export interface BandCandidate {
  id: string;
  bandMarkId: string | null;
  laneIndex: number;
  arcLength: number;
  center: Point;
  status: DerivationStatus;
  /** 唯一分子量（bp/kDa）；不能唯一决定时为 null。 */
  mass: number | null;
  unit: string;
  /** 全部合法候选（缺带枚举/重叠时保留多个）。 */
  legalCandidates: { mass: number; unit: string; segmentId: string }[];
  /** 区间结果（饱和/外推/重叠）。 */
  massRange: { min: number; max: number; unit: string } | null;
  segmentId: string | null;
  diagnostics: DiagnosticCodeLite[];
  /** 该候选所属校准段/标尺的有效区域（UI 露出有效区间）。 */
  validRegion: { sMin: number; sMax: number } | null;
}

export type DiagnosticCodeLite = string;

export interface Derivation {
  id: string;
  parents: string[];
  trigger: 'initial' | 'material-change' | 'params-change' | 'decision';
  inputSummary: InputSummary;
  calibrationPoints: LadderCalibrationPoint[];
  segments: CalibrationSegment[];
  bandCandidates: BandCandidate[];
  diagnostics: import('./diagnostics').Diagnostic[];
  /** 输入摘要哈希：同输入重放必须得到同结果。 */
  digest: string;
}

// ---------- 反例档案（机器可读取事件） ----------

export type CounterexampleKind =
  | 'rotation'
  | 'curved-lane'
  | 'ladder-missing'
  | 'saturation'
  | 'overlap'
  | 'nonmonotonic'
  | 'revision-local-invalidation';

export interface CounterexampleRecord {
  kind: 'counterexample';
  id: string;
  branchId: string;
  case: CounterexampleKind;
  /** 只改动的那一个直接来源（材料身份/字段指针）。 */
  changedSource: string;
  unchangedBaselineDigest: string;
  /** 受影响对象（身份集合，影响必须被限制在正确范围）。 */
  expectedAffected: string[];
  expectedUnaffected: string[];
  adopted: { eventId: string; verdict: 'accepted' | 'rejected'; note: string }[];
  rejectedAlternatives: { eventId: string; note: string }[];
  judgments: StructuredJudgment[];
}

export interface StructuredJudgment {
  id: string;
  rule:
    | 'same-y-not-same-mass-on-smile'
    | 'local-ruler-requires-valid-region'
    | 'saturated-is-candidate-or-range'
    | 'smear-is-candidate-or-range'
    | 'overlap-is-candidate-or-range'
    | 'all-legal-candidates-retained'
    | 'single-source-change-scoped-impact';
  evidenceEventIds: string[];
  holds: boolean;
  detail: string;
}
