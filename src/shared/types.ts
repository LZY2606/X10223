// ============================================================================
// 胶道标尺工作台 — 共享领域类型（服务端规则、存储、浏览器界面共用）
// 设计原则：
//  - 不可变材料（原图 / 拍摄方向 / 曝光 / ladder 标称值）一经导入只追加新版本
//  - 泳道曲线、条带中心等决定可修订，但每个版本都保留像素级来源与父依赖
//  - 所有领域量携带单位或坐标/时间基准；无法转换的值留在原位置并附诊断
// ============================================================================

export const RULES_VERSION = 'calibration-rules-1.0.0';

/** 三种必须彼此区分的结果类别 */
export type OutcomeKind =
  | 'OK'
  | 'BUDGET_EXHAUSTED' // 资源预算耗尽（枚举上限、像素预算、包体上限）
  | 'FORMAT_CORRUPT' // 格式损坏（PNG/JSON/校验和/结构不合法）
  | 'SEMANTIC_UNRESOLVABLE'; // 语义无解（非单调标尺、无可用 knot 等）

export type Severity = 'error' | 'warning' | 'info';

export interface PixelPos {
  /** 显示帧像素坐标（已按拍摄方向归一），允许亚像素 */
  x: number;
  y: number;
}

export interface Diagnostic {
  code: string;
  outcome?: Exclude<OutcomeKind, 'OK'>;
  severity: Severity;
  message: string;
  at?: {
    kind: 'image' | 'lane' | 'band' | 'ladder-band' | 'segment' | 'package' | 'project';
    id: string;
    /** 像素级位置（显示帧），用于“带位置的诊断” */
    position?: PixelPos;
    ordinal?: number;
  };
}

/** 拍摄方向（直接来源，不可变材料的一部分） */
export interface Orientation {
  /** 相机相对标准竖直电泳方向的顺时针旋转（90° 步进） */
  rotationCw: 0 | 90 | 180 | 270;
}

/** 曝光参数（直接来源，所有字段带单位） */
export interface Exposure {
  exposureTimeMs: number | null;
  iso: number | null;
  gain: number | null;
  /** 传感器满量程值（如 8 位图为 255），饱和判定基准 */
  sensorMax: number;
  rawText: string;
}

export interface ImageVersion {
  id: string; // img_ + 内容哈希
  eventId: string;
  filename: string;
  mediaType: 'image/png';
  widthPx: number;
  heightPx: number;
  sha256: string;
  orientation: Orientation;
  exposure: Exposure;
  /** 时间基准：原始拍摄时刻 ISO8601（缺失时为导入时刻并标注） */
  capturedAt: string;
  capturedAtAssumed: boolean;
}

/** ladder 标称条带：保留原始表示，派生层才规范化 */
export interface LadderNominalBand {
  ordinal: number; // 自上而下顺序（1 开始）
  raw: string; // 原始表示，如 "1000"、"3.0 kbp"、"N/A"
  normalized: { value: number; unit: 'bp' | 'kDa' } | null;
  diagnostic?: Diagnostic;
}

export interface LadderSpec {
  id: string;
  eventId: string;
  name: string;
  unit: 'bp' | 'kDa' | 'unknown';
  bands: LadderNominalBand[];
}

export type EvidenceSource = 'auto' | 'manual';

export interface Provenance {
  source: EvidenceSource;
  /** 产生当前版本的事件 id */
  eventId: string;
  /** 上一版本（修订链），首个版本为 null */
  supersedes: string | null;
  /** 自动候选的算法/参数版本；人工为 null */
  detectorVersion: string | null;
  confidence: number | null;
}

export interface LaneVersion {
  id: string; // 内容寻址
  laneId: string; // 跨版本稳定身份
  role: 'ladder' | 'sample';
  provenance: Provenance;
  /** 脊柱曲线点（显示帧像素），边界由半宽派生 */
  spine: PixelPos[];
  halfWidthPx: number;
  valid: boolean;
  diagnostics: Diagnostic[];
}

/** 条带区域的像素证据轮廓（阈值多边形，显示帧） */
export interface BandEvidence {
  peak: number; // 0..sensorMax
  saturated: boolean;
  saturatedFraction: number; // 区域内到达 sensorMax 的像素比例
  smear: boolean; // 拖尾
  overlap: boolean; // 与相邻条带重叠未分辨
  /** 沿泳道脊柱的强度轮廓采样（显示帧 y 像素 + 强度） */
  profile: { y: number; v: number }[];
  /** 条带区域轮廓多边形（像素） */
  contour: PixelPos[];
  /** 区域像素预算实际使用数 */
  regionPixels: number;
}

export interface BandVersion {
  id: string;
  bandId: string; // 跨版本稳定身份
  laneId: string;
  provenance: Provenance;
  center: PixelPos; // 像素级中心（显示帧）
  kind: 'ladder' | 'sample';
  /** ladder 条带：候选或已确认的标称序号 */
  ladderOrdinal: number | null;
  evidence: BandEvidence;
  valid: boolean;
  diagnostics: Diagnostic[];
}

// ---------------------------------------------------------------------------
// 校准与分子量推断（派生层，内容寻址、永不覆盖）
// ---------------------------------------------------------------------------

export interface LadderKnot {
  id: string;
  bandId: string;
  ordinal: number;
  mw: number;
  unit: 'bp' | 'kDa';
  /** 沿 ladder 泳道脊柱的弧长迁移坐标 */
  sPx: number;
  rf: number; // 0(上样端)..1(染料前沿)
  point: PixelPos;
  /** log 线性拟合在该 knot 的残差（log10 单位） */
  residualLog10: number | null;
}

export interface CalibrationSegment {
  id: string;
  knotAId: string;
  knotBId: string;
  /** 局部标尺有效区域：仅在该 rf 区间内可唯一插值 */
  rfMin: number;
  rfMax: number;
  slope: number; // d log10(mw) / d rf
  valid: boolean;
}

export interface CalibrationCandidate {
  id: string;
  /** 该候选使用的 ladder band -> ordinal 指派（bandId => ordinal） */
  assignment: Record<string, number>;
  status: 'candidate' | 'accepted' | 'rejected';
  knots: LadderKnot[];
  segments: CalibrationSegment[];
  rmsResidualLog10: number | null;
  valid: boolean;
  diagnostics: Diagnostic[];
  /** 机器可读判定依据 */
  judgments: Judgment[];
}

export type EstimateKind = 'point' | 'interval' | 'candidate';

export interface MwEstimate {
  id: string;
  bandId: string;
  laneId: string;
  kind: EstimateKind;
  /** 唯一点估计；无法唯一决定时为 null */
  value: number | null;
  /** 合法区间（bp 或 kDa），开区间用 ±Infinity 端点开闭标注 */
  interval: { low: number; high: number; openLow: boolean; openHigh: boolean } | null;
  /** 无法唯一决定时保留的全部合法候选值 */
  alternatives: number[];
  unit: 'bp' | 'kDa';
  rf: number;
  sPx: number;
  /** 支撑该值的插值段（点击回跳用）；越界时为 null */
  segmentId: string | null;
  valid: boolean;
  reasonCodes: string[];
  judgments: Judgment[];
  /** 输入摘要 + 参数版本 + 父依赖（随派生结果一起记录） */
  derivation: DerivationInfo;
}

export interface DerivationInfo {
  inputSummary: string[]; // 直接输入的内容指纹
  paramVersion: string; // 参数版本（含规则版本 + 项目参数修订）
  parents: string[]; // 父级依赖（事件/材料/上游派生的 id）
  rulesVersion: string;
}

export interface Judgment {
  /** 机器可读判定码 */
  code:
    | 'SMILE_ARC_LENGTH_LOCAL_SCALE'
    | 'SATURATION_ONLY_CANDIDATE'
    | 'SMEAR_ONLY_INTERVAL'
    | 'OVERLAP_ONLY_INTERVAL'
    | 'NONMONOTONIC_SCALE_UNRESOLVABLE'
    | 'MISSING_LADDER_BAND_KEEP_CANDIDATES'
    | 'OUT_OF_RANGE_OPEN_INTERVAL'
    | 'LOCAL_INVALIDATION_AFTER_REVISION';
  rule: string; // 规则原文标识
  subjectId: string;
  message: string;
  data: Record<string, number | string | boolean>;
}

// ---------------------------------------------------------------------------
// 事件溯源
// ---------------------------------------------------------------------------

export type EventType =
  | 'project_created'
  | 'image_imported'
  | 'ladder_named'
  | 'lanes_detected'
  | 'lane_revised'
  | 'bands_detected'
  | 'band_revised'
  | 'calibration_params_changed'
  | 'candidate_accepted'
  | 'candidate_rejected'
  | 'estimate_accepted'
  | 'estimate_rejected'
  | 'conflicting_decision'
  | 'note';

export interface EventRecord {
  id: string;
  seq: number; // 全局稳定顺序（项目内单调）
  branchId: string;
  parentId: string | null;
  type: EventType;
  actor: 'auto' | 'user';
  at: string; // ISO8601 时间基准
  /** 逻辑时钟（同一分支上的决定次序，导入时保留） */
  tick: number;
  payload: Record<string, unknown>;
  inputSummary: string[];
  paramVersion: string;
  parents: string[];
  /** 该事件产生/采纳的对象 id（导出导入后保持） */
  produces: string[];
}

export interface Branch {
  id: string;
  name: string;
  forkFromEventId: string | null;
  headEventId: string | null;
  createdAt: string;
}

export interface ProjectState {
  projectId: string;
  title: string;
  branchId: string;
  atEventId: string; // 当前视图对应事件
  image: ImageVersion | null;
  ladder: LadderSpec | null;
  lanes: LaneVersion[];
  bands: BandVersion[];
  calibrationCandidates: CalibrationCandidate[];
  acceptedCalibrationId: string | null;
  estimates: MwEstimate[];
  diagnostics: Diagnostic[];
  judgments: Judgment[];
  paramVersion: string;
}

export interface ProjectMeta {
  id: string;
  title: string;
  kind: 'baseline' | 'counterexample' | 'imported' | 'scratch';
  scenario?: string;
  headBranchId: string;
}

// ---------------------------------------------------------------------------
// 导出包 / 反例档案
// ---------------------------------------------------------------------------

export interface CasePackage {
  format: 'gel-case-package/v1';
  exportedAt: string;
  project: { id: string; title: string; kind: ProjectMeta['kind']; scenario?: string };
  branches: Branch[];
  events: EventRecord[];
  /** 不可变材料（图像 PNG 以 base64 保存原始字节） */
  materials: {
    images: Array<Omit<ImageVersion, 'eventId'> & { eventId: string; pngBase64: string }>;
  };
  /** 已采纳与未采纳结果都随包保存 */
  decisions: {
    acceptedCalibrationByBranch: Record<string, string | null>;
    rejectedCandidateIds: string[];
    rejectedEstimateIds: string[];
  };
  rulesVersion: string;
  checksumSha256: string;
}
