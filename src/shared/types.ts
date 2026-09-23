/**
 * 领域类型：胶道标尺（电泳条带、泳道弯曲与分子量校准）。
 *
 * 分层原则：
 * - Material / Observation / Decision 是不可变材料与人工决定（原始表示，像素级来源）。
 * - Result 是派生层（规范化单位、数值推断），记录输入摘要、参数版本、父级依赖。
 * - 所有计算不覆盖历史，而是生成新事件、新版本。
 */

export type Unit =
  | 'bp' // 核酸长度（碱基对）
  | 'kDa' // 蛋白质分子量
  | 'nt';

/** 数值标量：携带单位或坐标基准，显示时不允许丢失。 */
export interface QNumber {
  value: number;
  unit: Unit;
  raw?: string; // 导入时的原始表示
}

/** 图像像素坐标（均以 imageId 对应原图为基准）。 */
export interface PixelPoint {
  x: number; // 像素列，float 允许亚像素
  y: number; // 像素行，float 允许亚像素
}

/** 坐标基准：所有几何量都必须能回到哪张图、哪一帧。 */
export interface CoordRef {
  imageId: string;
  frame: 'original'; // 本系统统一以原图为像素基准；旋转只改变 canonical 帧，不改像素来源
}

// ---------------------------------------------------------------------------
// 不可变材料
// ---------------------------------------------------------------------------

export type MaterialType = 'image' | 'capture' | 'ladder' | 'layout';

export interface BlobRef {
  blobId: string;
  sha256: string;
  bytes: number;
  mediaType: 'image/png';
}

export interface ImageMaterial {
  kind: 'image';
  id: string;
  blob: BlobRef;
  width: number;
  height: number;
  /** 拍摄方向（相对 canonical，凝胶泳道竖直、迁移向下）。90 表示原图顺时针旋转 90° 才得到 canonical。 */
  orientationDeg: 0 | 90 | 180 | 270;
  /** 像素级来源：若该图由另一张图旋转生成，记录来源；导入的图为 null。 */
  source: { kind: 'import' } | { kind: 'derived-rotate'; fromImageId: string; angleDeg: 90 | 180 | 270 };
}

export interface CaptureMaterial {
  kind: 'capture';
  id: string;
  imageId: string;
  /** 曝光：保留原始表示（如 "80ms" / "+1.2 EV"）。无法转换则保留原文 + 诊断。 */
  exposureRaw: string;
  exposureMs: number | null; // 派生：能解析时给出
  gainRaw?: string;
  gamma: number;
  bitDepth: number;
  /** 饱和阈值（>= 该灰度判为饱和/过曝）。 */
  saturationGray: number;
  capturedAt: string | null; // 时间基准（ISO8601），未知为 null 而非伪造
  capturedAtRaw?: string | null;
}

export interface LadderBandNominal {
  /** 标称条目在标准中的稳定身份（按标称值排序）。 */
  nominalId: string;
  indexTop: number; // 标称由胶顶（迁移小）到胶底的序号，0 起
  nominal: QNumber;
  present: boolean; // 本张胶的 ladder 是否出现该标称带（缺带=false）
  missingReason?: string;
}

export interface LadderMaterial {
  kind: 'ladder';
  id: string;
  name: string;
  unit: Unit;
  /** 标称值按 indexTop 升序，迁移距离单调递增、标称值单调递减。 */
  bands: LadderBandNominal[];
  rawNotation?: string; // 导入时的原始标称文本
}

export type LaneRole = 'ladder' | 'sample' | 'empty';

export interface LaneAssignment {
  laneId: string;
  orderLeft: number; // 从左到右 0 起
  role: LaneRole;
  ladderId?: string; // role=ladder 时
  sampleName?: string; // role=sample 时
}

export interface LaneLayoutMaterial {
  kind: 'layout';
  id: string;
  imageId: string;
  lanes: LaneAssignment[];
}

export type Material = ImageMaterial | CaptureMaterial | LadderMaterial | LaneLayoutMaterial;

// ---------------------------------------------------------------------------
// 观测（像素级来源；auto 候选与人工修订并存）
// ---------------------------------------------------------------------------

export type ObservationKind = 'lane-boundary' | 'band-center' | 'ladder-link';

export interface LaneBoundaryObservation {
  kind: 'lane-boundary';
  id: string;
  imageId: string;
  laneId: string;
  /** 泳道边界为折线（像素点列），表达弯曲泳道；直线泳道是端点两个点。 */
  leftEdge: PixelPoint[];
  rightEdge: PixelPoint[];
  origin: 'auto' | 'human';
  /** 人工修订所否决/替换的候选观测 id（保留未采纳结果）。 */
  supersedesObservationId?: string | null;
  confidence?: number;
}

export interface BandCenterObservation {
  kind: 'band-center';
  id: string;
  imageId: string;
  laneId: string;
  /** 条带中心，像素级。 */
  center: PixelPoint;
  /** 候选边界框（像素），供轮廓叠加。 */
  bbox: { left: number; top: number; right: number; bottom: number };
  origin: 'auto' | 'human';
  supersedesObservationId?: string | null;
  /** 候选标记：饱和、拖尾、重叠时只能作为候选或区间。 */
  flags: BandFlag[];
  /** 重叠时，检测器给出的全部合法候选中心。 */
  alternatives?: PixelPoint[];
  confidence?: number;
}

export type BandFlag =
  | 'saturated'
  | 'trailing'
  | 'overlap'
  | 'faint'
  | 'broad';

export interface LadderLinkObservation {
  kind: 'ladder-link';
  id: string;
  imageId: string;
  laneId: string;
  bandObservationId: string;
  nominalId: string;
  origin: 'auto' | 'human';
  supersedesObservationId?: string | null;
}

export type Observation =
  | LaneBoundaryObservation
  | BandCenterObservation
  | LadderLinkObservation;

// ---------------------------------------------------------------------------
// 参数（带版本，决定引用具体版本）
// ---------------------------------------------------------------------------

export interface CalibrationParamsV1 {
  schema: 'calibration-params/v1';
  /** 曲率估计的最大相邻 ladder 泳道数等。 */
  minBandsForRuler: number;
  /** 局部标尺有效区域外推允许比例（0=禁止外推）。 */
  extrapolateTolerance: number;
  /** 曲率不可忽略阈值（像素的二次项幅度，超过则同一高度不等于同一分子量）。 */
  curvatureSignificantPx: number;
  /** 残差告警阈值（标称单位对数域）。 */
  residualLogWarn: number;
  /** 饱和带 / 重叠带的推断是否允许点值（false=只给区间/候选）。 */
  allowAmbiguousPointEstimate: boolean;
  /** 标尺是否限定为“各 ladder 泳道局部标尺”。false 表示尝试全局统一标尺。 */
  localRulerOnly: boolean;
}

export interface ParamsVersion {
  id: string;
  schema: 'calibration-params/v1';
  values: CalibrationParamsV1;
  parentParamsId: string | null;
  note: string;
}

// ---------------------------------------------------------------------------
// 诊断：带位置、分类；输入不完整不得伪装成功
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  /** 受影响对象（稳定身份）。 */
  subjectIds: string[];
  /** 像素级位置（可空，但不得用默认值伪造）。 */
  at?: PixelPoint | null;
  laneId?: string;
  bandObservationId?: string;
  segmentId?: string;
}

/** 三类必须互不相同的顶层结果。 */
export type OutcomeKind = 'ok' | 'budget-exhausted' | 'format-corrupt' | 'semantic-unresolvable' | 'incomplete';

// ---------------------------------------------------------------------------
// 派生结果：输入摘要 + 参数版本 + 父级依赖
// ---------------------------------------------------------------------------

export interface ResultBase {
  kind: string;
  id: string;
  caseId: string;
  paramsId: string;
  inputDigest: string; // 输入摘要（规范 JSON 哈希）
  parents: string[]; // 父级依赖（结果 / 观测 / 材料 id）
  status: 'valid' | 'candidate' | 'interval' | 'unavailable' | 'invalid';
  diagnostics: Diagnostic[];
  /** 本次计算使用的资源预算。 */
  budget?: BudgetReport;
}

export interface BudgetReport {
  pixelBudget: number;
  pixelsUsed: number;
  exhausted: boolean;
}

export interface DetectedLane {
  laneId: string;
  /** 检测中心线折线（canonical 像素）。 */
  centerline: PixelPoint[];
  leftEdge: PixelPoint[];
  rightEdge: PixelPoint[];
  confidence: number;
}

export interface LaneDetectionResult extends ResultBase {
  kind: 'lane-detection';
  imageId: string;
  lanes: DetectedLane[];
}

export interface BandProfilePoint {
  t: number; // 沿中心线纵向参数（像素，canonical）
  x: number; // 实际采样列
  y: number; // 实际采样行
  intensity: number; // 0..255
}

export interface DetectedBand {
  bandObservationId: string;
  laneId: string;
  center: PixelPoint;
  /** 沿中心线上的纵向参数 t（用于标尺迁移距离）。 */
  t: number;
  peakIntensity: number;
  widthPx: number;
  flags: BandFlag[];
  alternatives: PixelPoint[];
  /** 轮廓采样按 laneId 存放在 laneProfiles。 */
}

export interface LaneProfile {
  laneId: string;
  points: BandProfilePoint[];
}

export interface BandDetectionResult extends ResultBase {
  kind: 'band-detection';
  imageId: string;
  laneDetectionId: string;
  bands: DetectedBand[];
  laneProfiles: LaneProfile[];
}

export interface RulerSegment {
  segmentId: string;
  ladderLaneId: string;
  /** 相邻两个已链接 ladder 点。 */
  fromNominalId: string;
  toNominalId: string;
  fromT: number;
  toT: number;
  /** 有效区域：t 区间（该 ladder 泳道）与 x 区间（横向）。 */
  validTRange: [number, number];
  validXRange: [number, number];
  /** 插值 log(标称) 关于 t 的斜率（局部标尺）。 */
  slope: number;
  intercept: number;
  monotonic: boolean;
  /** 该段插值对观测点的残差（log 域）。 */
  residualLog: number;
}

export interface LadderRulerPoint {
  nominalId: string;
  bandObservationId: string;
  laneId: string;
  t: number;
  logNominal: number;
  x: number;
}

export interface CalibrationResult extends ResultBase {
  kind: 'calibration';
  ladderId: string;
  unit: Unit;
  /** 曲率模型 x(t,y)：局部迁移 t_corr = t + k * (x-xRef)^2 的 k（1/px）。null=无法判定。 */
  curvatureK: number | null;
  curvatureReferenceX: number | null;
  curvatureSignificant: boolean;
  rulerPoints: LadderRulerPoint[];
  segments: RulerSegment[];
  /** 全局线性标尺（仅在曲率可忽略且跨 ladder 一致时 valid），否则 invalid 并给原因。 */
  globalFit: {
    status: 'valid' | 'invalid';
    slope: number | null;
    intercept: number | null;
    rmsResidualLog: number | null;
    invalidReason?: string;
  };
}

export interface MwEstimate {
  bandObservationId: string;
  laneId: string;
  /** 点值（仅在非候选且标尺有效时给出）。 */
  point: QNumber | null;
  /** 区间（饱和/拖尾/重叠/缺带时给出），闭区间，单位同 ladder。 */
  interval: { low: QNumber; high: QNumber } | null;
  /** 重叠时全部合法候选点值。 */
  candidates: QNumber[];
  status: ResultBase['status'];
  /** 采用的插值段身份（点击分子量回到 ladder 点与插值段）。 */
  segmentId: string | null;
  ladderLaneId: string | null;
  /** 校正后的迁移位置与有效区间判定。 */
  correctedT: number | null;
  withinValidRegion: boolean;
  uncertaintyReason: string[];
}

export interface MwResult extends ResultBase {
  kind: 'mw';
  calibrationId: string;
  bandDetectionId: string;
  unit: Unit;
  estimates: MwEstimate[];
}

export type DerivedResult =
  | LaneDetectionResult
  | BandDetectionResult
  | CalibrationResult
  | MwResult;

// ---------------------------------------------------------------------------
// 事件（append-only，分支与决定历史）
// ---------------------------------------------------------------------------

export type EventType =
  | 'case-created'
  | 'material-added'
  | 'observations-detected'
  | 'human-revision'
  | 'params-changed'
  | 'decision'
  | 'derived-computed'
  | 'branch-created';

export type DecisionValue =
  | { kind: 'accept-band'; bandObservationId: string }
  | { kind: 'reject-band'; bandObservationId: string; reason: string }
  | { kind: 'accept-lane'; laneId: string }
  | { kind: 'set-overlap-resolution'; bandObservationId: string; chosenAlternativeIndex: number }
  | { kind: 'use-global-ruler' }
  | { kind: 'use-local-ruler' }
  | { kind: 'note'; text: string };

export interface CaseEvent {
  id: string;
  caseId: string;
  branchId: string;
  seq: number; // 分支内序号
  parentEventId: string | null;
  type: EventType;
  timestamp: string; // ISO8601
  summary: string;
  /** 机器可读：结构化状态与判断依据，而不是只写日志。 */
  payload: Record<string, unknown>;
  /** 该事件涉及材料/观测/结果的稳定身份（受影响对象）。 */
  subjectIds: string[];
  /** 前一事件哈希（含分支链），用于导出校验。 */
  prevHash: string | null;
  hash: string;
}

export interface Branch {
  id: string;
  caseId: string;
  name: string;
  parentBranchId: string | null;
  forkEventId: string | null;
  createdAt: string;
}

// ---------------------------------------------------------------------------
// 案例 / 导出包
// ---------------------------------------------------------------------------

export interface Case {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  headEventId: Record<string, string>; // branchId -> head event id
}

export interface BlobEntry {
  blobId: string;
  sha256: string;
  bytes: number;
  mediaType: string;
  /** base64 载荷。 */
  dataBase64: string;
}

export interface CaseBundle {
  format: 'gel-ruler-bundle';
  formatVersion: 1;
  case: Case;
  branches: Branch[];
  events: CaseEvent[];
  materials: Material[];
  observations: Observation[];
  paramsVersions: ParamsVersion[];
  results: DerivedResult[];
  blobs: BlobEntry[];
  exportedAt: string;
  bundleDigest: string;
}

export interface StoredCaseSnapshot {
  case: Case;
  branches: Branch[];
  events: CaseEvent[];
  materials: Material[];
  observations: Observation[];
  paramsVersions: ParamsVersion[];
  results: DerivedResult[];
  headEventIdByBranch: Record<string, string>;
}
