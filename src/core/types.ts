/**
 * 领域类型定义。
 *
 * 分层原则：
 *  - Material（不可变材料）：原图、拍摄方向、曝光、ladder 标称值、
 *    lane 边界、条带中心，全部带像素级 / 外部来源，导入时保留原始表示。
 *  - Event（决定历史）：追加式、带父级哈希链与分支。
 *  - Derivation（派生层）：规范化与计算结果，记录输入摘要、参数版本、父级依赖。
 *
 * 所有领域量携带单位或坐标基准；无法转换的值留在原位并附诊断，
 * 绝不使用空值或默认值伪装成功。
 */

export type Unit =
  | 'bp' // 分子量（碱基对）
  | 'pixel' // 像素长度 / 坐标
  | 'degree' // 角度
  | 'ms' // 曝光时间
  | 'graylevel' // 0..255 灰度
  | 'count' // 无量纲计数
  | 'ratio' // 无量纲比例
  | 'intensity'; // 相对强度

/** 所有领域量都带单位与原始表示。 */
export interface Quant {
  value: number;
  unit: Unit;
  /** 导入时的原始表示（字符串/数字），派生层才做规范化。 */
  raw?: string;
}

/** 像素坐标基准：所有像素量都必须能回到某张图的某个像素。 */
export interface PixelProvenance {
  kind: 'pixel';
  imageId: string;
  /** 像素坐标（图像自身坐标系，旋转前为原图坐标）。 */
  x: Quant;
  y: Quant;
  /** 采样窗口半径（像素），标量或椭圆。 */
  radius?: Quant;
  /** 该像素的原始灰度（0..255，未做曝光归一化）。 */
  gray?: Quant;
  /** 坐标采用的帧：original=原图帧，rotated=旋转后帧。 */
  frame: 'original' | 'rotated';
  /** 当 frame=rotated 时记录变换链，可回到原图。 */
  transformChain?: TransformRef[];
  note?: string;
}

export interface ExternalProvenance {
  kind: 'external';
  source: string; // 例如 "ladder datasheet: HyperLadder 1kb"
  lot?: string;
  rawLabel?: string;
  note?: string;
}

export type Provenance = PixelProvenance | ExternalProvenance;

export interface TransformRef {
  transformId: string;
  type: 'rotate';
  clockwiseDegrees: number;
}

export type MaterialType =
  | 'gel-image'
  | 'orientation'
  | 'exposure'
  | 'ladder-spec'
  | 'lane-boundaries'
  | 'band-centers';

export interface MaterialBase {
  id: string;
  type: MaterialType;
  projectId: string;
  /** 来源 actor：auto=自动候选，human=人工修订/采纳，vendor=外部标称。 */
  origin: 'auto' | 'human' | 'vendor';
  provenance: Provenance[];
  createdAt: number;
  /** 人工或自动来源的原始表示片段，供“输入片段”留档。 */
  rawRepresentation: unknown;
}

export interface GelImageMaterial extends MaterialBase {
  type: 'gel-image';
  pngSha256: string;
  width: Quant;
  height: Quant;
  channels: 1;
  /** 原图本身的方向（拍摄方向材料单独描述）。 */
  isOriginal: boolean;
  /** 若由其它图像旋转得到，记录父图像与角度；原图无此字段。 */
  derivedFrom?: { parentImageId: string; clockwiseDegrees: number };
}

export interface OrientationMaterial extends MaterialBase {
  type: 'orientation';
  imageId: string;
  /** 标注的拍摄方向：top=点样孔在上方（标准）。 */
  loadingWellSide: 'top' | 'bottom' | 'left' | 'right';
  /** 相对标准方向需要顺时针旋转的角度（0/90/180/270）。 */
  rotateClockwise: Quant;
}

export interface ExposureMaterial extends MaterialBase {
  type: 'exposure';
  imageId: string;
  exposureTime: Quant; // ms
  gain: Quant; // ratio
  /** 灰度裁剪阈值（>= 视为饱和，255 为硬饱和）。 */
  saturationGray: Quant;
  bitDepth: Quant;
}

export interface LadderBandNominal {
  /** 该标称带在 ladder 泳道的像素中心来源。 */
  center: PixelProvenance;
  nominalBp: Quant;
  /** 该标称带是否被供应商清单标注存在（缺带检测用）。 */
  expected: boolean;
}

export interface LadderSpecMaterial extends MaterialBase {
  type: 'ladder-spec';
  ladderLaneId: string;
  productName: string;
  /** 标称分子量序列（bp），按分子量降序（电泳方向上从上到下）。 */
  bands: LadderBandNominal[];
}

/** 泳道中心线用折线表达，天然支持“微笑”弯曲。 */
export interface LaneGeometryMaterial extends MaterialBase {
  type: 'lane-boundaries';
  imageId: string;
  lanes: LaneSpec[];
}

export interface LaneSpec {
  laneId: string;
  label: string;
  role: 'ladder' | 'sample';
  /** 左/右边界折线（像素，原图帧）。 */
  leftBoundary: Point[];
  rightBoundary: Point[];
  /** 中心线折线（像素，原图帧），沿电泳方向由上至下。 */
  centerline: Point[];
}

export interface Point {
  x: Quant;
  y: Quant;
}

export interface BandCenterMaterial extends MaterialBase {
  type: 'band-centers';
  imageId: string;
  laneId: string;
  /** 条带中心（像素，原图帧），每个都有独立像素来源。 */
  centers: PixelProvenance[];
}

export type Material =
  | GelImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderSpecMaterial
  | LaneGeometryMaterial
  | BandCenterMaterial;

// ---------------------------------------------------------------------------
// 事件（追加式决定历史）
// ---------------------------------------------------------------------------

export type EventType =
  | 'project-created'
  | 'material-added'
  | 'parameter-revised'
  | 'decision'
  | 'branch-created';

export interface BaseEvent {
  id: string; // 由 projectId+seq+payload+prevId 派生
  projectId: string;
  seq: number;
  branchId: string;
  type: EventType;
  prevId: string | null;
  timestamp: number;
  payload: unknown;
}

export interface MaterialAddedPayload {
  materialId: string;
  materialType: MaterialType;
  /** 是否替换同一身份槽位的旧材料（材料本身不可变，这里只是选择新版本）。 */
  supersedesId?: string;
}

export interface ParameterRevisedPayload {
  scope: 'global' | { laneId: string };
  key: string;
  value: number;
  unit: Unit;
  reason: string;
}

export interface DecisionPayload {
  kind: 'accept' | 'reject' | 'adjust';
  /** 被决定对象：派生条带 / 校准。 */
  targetRef: DerivedRef;
  /** 决定时依据的派生结果内容身份（哈希链快照点）。 */
  basedOnDerivationId: string;
  /** accept 时选定的候选（无法唯一决定时记录被采纳的合法候选）。 */
  selectedCandidateId?: string;
  /** adjust 时记录参数覆盖。 */
  adjustment?: { key: string; value: number; unit: Unit };
  note: string;
}

export interface DerivedRef {
  kind: 'band' | 'lane-calibration' | 'case-result';
  laneId?: string;
  bandId?: string;
}

export type GelEvent = BaseEvent;

// ---------------------------------------------------------------------------
// 诊断与计算结果
// ---------------------------------------------------------------------------

export type Severity = 'error' | 'warning' | 'info';

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  /** 带位置：像素来源或字段路径，绝不空泛。 */
  at?: PixelProvenance | { path: string; materialId?: string };
}

export type DeriveStatus = 'ok' | 'candidate' | 'interval' | 'invalid';

export interface DerivedBand {
  bandId: string;
  laneId: string;
  /** 迁移距离（沿中心线弧长，像素，原图帧）。 */
  migration: Quant;
  /** 推断分子量；无法唯一决定时为合法候选集合。 */
  candidates: MwCandidate[];
  status: DeriveStatus;
  diagnostics: Diagnostic[];
  /** 峰值轮廓证据（采样强度曲线）。 */
  profile: ProfilePoint[];
  saturation: { saturated: boolean; maxGray: Quant; clippingFraction: Quant };
  tailing: { tailed: boolean; asymmetry: Quant };
  overlap: { overlapped: boolean; withBandId?: string };
  /** 人工决定（若有）。 */
  decision?: { kind: 'accept' | 'reject' | 'adjust'; selectedCandidateId?: string; note: string };
  /** 该条带被采纳的最终分子量（仅当存在 accept 决定）。 */
  acceptedBp?: Quant;
}

export interface MwCandidate {
  candidateId: string;
  bp: Quant;
  /** 区间候选给出上下界；点候选 lo=hi。 */
  bpLow: Quant;
  bpHigh: Quant;
  kind: 'point' | 'interval' | 'extrapolated';
  sourceSegmentId: string | null; // 回到插值段
  legal: boolean;
}

export interface ProfilePoint {
  s: Quant; // 沿中心线弧长
  gray: Quant; // 原始灰度
  x: Quant;
  y: Quant;
}

export interface CalibrationSegment {
  segmentId: string;
  fromLadderBandId: string;
  toLadderBandId: string;
  /** 有效迁移区间 [sLo, sHi]（像素弧长）。 */
  sLo: Quant;
  sHi: Quant;
  bpLo: Quant;
  bpHI: Quant;
}

export interface LadderPoint {
  ladderBandId: string;
  s: Quant;
  nominalBp: Quant;
  center: PixelProvenance;
  /** 残差：log10 bp 全局拟合残差。 */
  fitResidual: Quant;
  detected: boolean;
}

export interface LaneCalibration {
  laneId: string;
  status: DeriveStatus;
  ladderPoints: LadderPoint[];
  segments: CalibrationSegment[];
  /** 标尺整体有效迁移区间；微笑使跨 lane 共享高度无效，故按 lane 局部。 */
  validRegion: { sLo: Quant; sHi: Quant } | null;
  diagnostics: Diagnostic[];
  /** 非单调检测。 */
  monotonic: boolean;
  /** 朴素“同高度=同分子量”结果，仅用于反面对照。 */
  naiveSharedHeightBp?: Quant;
}

export interface LaneDerivation {
  lane: LaneSpec;
  calibration: LaneCalibration;
  bands: DerivedBand[];
}

export interface ParameterSet {
  /** 内容身份（由 scope/key/value 派生），作为参数版本。 */
  id: string;
  global: Record<string, { value: number; unit: Unit }>;
  perLane: Record<string, Record<string, { value: number; unit: Unit }>>;
}

export interface DerivationInputSummary {
  materialHashes: Record<string, string>; // materialId -> sha256(canonical material)
  parameterVersion: string;
  imageId: string;
}

export interface ProjectDerivation {
  derivationId: string; // 内容寻址
  projectId: string;
  branchId: string;
  headEventId: string;
  ruleVersion: string;
  inputSummary: DerivationInputSummary;
  lanes: LaneDerivation[];
  diagnostics: Diagnostic[];
  computedAt: number;
  /** 资源预算。 */
  budget: BudgetReport;
}

export interface BudgetReport {
  limitOps: number;
  usedOps: number;
  exhausted: boolean;
}

export interface ProjectState {
  projectId: string;
  branchId: string;
  headEventId: string | null;
  materials: Record<string, Material>;
  /** 每类材料当前选中版本（不可变材料的“可修改选择”）。 */
  selected: Partial<Record<MaterialType, string>>;
  /** band-centers 按 lane 选择。 */
  selectedBands: Record<string, string>;
  events: GelEvent[];
  parameters: ParameterSet;
}
