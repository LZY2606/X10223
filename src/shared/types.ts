/**
 * 胶道标尺 · 共享领域类型
 *
 * 分层原则：
 *  - 不可变材料层 (Material)：原图、拍摄方向、曝光、ladder 标称值、lane 边界、条带中心
 *    均保留像素级来源，只追加，不就地修改。
 *  - 决定层 (Decision)：人工接受/否定/修订/参数版本，只追加。
 *  - 派生层 (Derivation)：由材料 + 决定 + 参数版本计算，记录输入摘要与父级依赖。
 *
 * 所有领域量携带单位或坐标基准；原始表示在 import 层保留，派生层才规范化。
 */

export type Severity = 'error' | 'warning' | 'info';

/** 带位置的诊断：输入不完整时返回诊断，绝不用空值/默认值伪装成功 */
export interface DiagnosticPosition {
  /** 指向输入片段的稳定路径，如 events[12].payload.points[3].y */
  path?: string;
  /** 像素坐标基准（pixel@imageId），用于在叠加图上定位 */
  x?: number;
  y?: number;
  tArc?: number;
  laneId?: string;
  bandId?: string;
  ladderEntryId?: string;
  segmentId?: string;
  branch?: string;
}

export type DiagnosticCode =
  | 'INCOMPLETE_INPUT'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNRESOLVABLE'
  | 'RESOURCE_BUDGET_EXHAUSTED'
  | 'NON_MONOTONIC_LADDER'
  | 'LADDER_BAND_MISSING'
  | 'LADDER_ASSIGNMENT_AMBIGUOUS'
  | 'SATURATED_BAND'
  | 'TAILING_BAND'
  | 'OVERLAPPING_BANDS'
  | 'OUTSIDE_VALID_REGION'
  | 'UNCONVERTIBLE_UNIT'
  | 'CONFLICTING_DECISIONS'
  | 'ROTATION_UNKNOWN'
  | 'CURVED_LANE_LOCAL_SCALE'
  | 'HALF_WRITE_RECOVERED';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  position: DiagnosticPosition;
}

/** 三种必须不同的结果类型之一：资源耗尽 / 格式损坏 / 语义无解 */
export type FailureKind =
  | 'RESOURCE_BUDGET_EXHAUSTED'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNRESOLVABLE';

export interface Failure {
  kind: FailureKind;
  diagnostics: Diagnostic[];
}

export type Outcome<T> =
  | { ok: true; value: T; diagnostics: Diagnostic[] }
  | { ok: false; failure: Failure };

/** 带单位的领域量。rawText 保留导入时的原始表示；无法转换时留在原位置并附诊断 */
export interface Quantity {
  /** 原始文本表示（不规范化） */
  rawText: string;
  value?: number;
  /** 规范化单位，如 bp / kDa / px / ms / s / ev */
  unit?: string;
  convertible: boolean;
  diagnostic?: Diagnostic;
}

/** 坐标基准：所有像素坐标必须声明所属图像版本 */
export interface CoordinateBasis {
  imageId: string;
  /** pixel-coordinate-origin: top-left */
  origin: 'top-left';
  units: 'px';
  /** 该图像版本相对原图的方向（顺时针度数） */
  orientationDeg: 0 | 90 | 180 | 270;
}

export interface PixelPoint {
  x: number;
  y: number;
  basis: CoordinateBasis;
}

/** 拍摄方向：不可变材料（旋转图像是“只改动一个直接来源”后的新版本） */
export interface OrientationMaterial {
  kind: 'orientation';
  declaredBy: 'exif' | 'operator' | 'auto';
  /** 顺时针旋转角度，仅允许离散值 */
  upDegrees: 0 | 90 | 180 | 270;
  confidence: number;
  rawText?: string;
}

/** 曝光：不可变材料，派生层据此判定饱和 */
export interface ExposureMaterial {
  kind: 'exposure';
  duration: Quantity;
  gain?: Quantity;
  /** 传感器满量程，用于像素级饱和判定 */
  fullScale: number;
  /** 饱和判定阈值占满量程比例，参数版本 gel.saturation/1.0 */
  saturationFraction: number;
  rawText?: string;
}

/** 原图：像素级来源，字节寻址、内容寻址 */
export interface RawImageMaterial {
  kind: 'rawImage';
  imageId: string;
  width: number;
  height: number;
  channels: 1 | 3;
  bitDepth: 8 | 16;
  sha256: string;
  /** 原始编码字节在 blob 存储中的地址 */
  blobUri: string;
  byteLength: number;
  /** 该版本相对父图像的像素级变换来源（旋转时只有这一个直接来源被改动） */
  pixelTransform?: {
    type: 'rotateCW';
    degrees: 90 | 180 | 270;
    parentImageId: string;
  };
}

/** ladder 标称值：不可变材料，保留原始表示与单位 */
export interface LadderNominalEntry {
  entryId: string;
  nominal: Quantity;
  /** 导入顺序（非排序顺序），等价输入得到稳定顺序 */
  ordinal: number;
}

export type LadderRole = 'sizeDNA' | 'massProtein';

export interface LadderMaterial {
  kind: 'ladder';
  ladderId: string;
  role: LadderRole;
  entries: LadderNominalEntry[];
  rawText: string;
}

/** 样条曲线（lane 中心/边界）：像素级来源，保留控制点 */
export interface LaneCurve {
  /** 三次 Catmull-Rom 样条控制点（像素坐标） */
  controlPoints: PixelPoint[];
  /** 单侧半宽（px），随弧长分段常数 */
  halfWidthPx: number[];
}

/** lane 边界：不可变材料（自动候选或人工修订都生成新版本） */
export type LaneBoundarySource = 'auto' | 'operator';

export interface LaneBoundaryMaterial {
  kind: 'laneBoundary';
  laneId: string;
  ordinal: number;
  label: string;
  isLadderLane: boolean;
  source: LaneBoundarySource;
  center: LaneCurve;
  /** 像素来源摘要：边界像素统计 */
  pixelEvidence: {
    boundaryXs: number[];
    meanIntensity: number;
    sampledRows: number;
  };
}

/** 条带中心：像素级来源（沿 lane 弧长定位） */
export type BandCenterSource = 'auto' | 'operator';

export interface BandCenterMaterial {
  kind: 'bandCenter';
  bandId: string;
  laneId: string;
  center: PixelPoint;
  /** 沿 lane 中心线的弧长坐标（px，来自顶部迁移前沿），坐标基准随点携带 */
  tArcPx: number;
  source: BandCenterSource;
  widthPx: number;
  /** 像素级强度证据 */
  intensity: {
    peak: number;
    background: number;
    /** 峰面积（像素强度积分） */
    area: number;
    /** 是否触及满量程（饱和） */
    saturated: boolean;
    /** 拖尾度量（下行质心偏移） */
    tailingScore: number;
    tailing: boolean;
    saturationFraction: number;
  };
  /** 与相邻条带的重叠像素占比（>0 表示重叠） */
  overlapWith?: { bandId: string; overlapFraction: number }[];
}

export type MaterialKind =
  | RawImageMaterial['kind']
  | OrientationMaterial['kind']
  | ExposureMaterial['kind']
  | LadderMaterial['kind']
  | LaneBoundaryMaterial['kind']
  | BandCenterMaterial['kind'];

export type Material =
  | RawImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderMaterial
  | LaneBoundaryMaterial
  | BandCenterMaterial;

/** 参数版本：计算永远携带版本号，修订产生新版本而不覆盖 */
export interface ParamSet {
  /** 如 gel.calibration/2.0 */
  version: string;
  values: Record<string, number | string>;
  parentVersion?: string;
}

export type DecisionType =
  | 'acceptAutoLanes'
  | 'acceptAutoBands'
  | 'reviseLaneCurve'
  | 'reviseBandCenter'
  | 'assignLadder'
  | 'resolveLadderAssignment'
  | 'acceptMwCandidate'
  | 'overrideMw'
  | 'rejectBand'
  | 'paramRevision'
  | 'conflictNote';

export type DerivationStatus =
  | 'candidate'
  | 'accepted'
  | 'rejected'
  | 'interval'
  | 'ambiguous'
  | 'invalidated';

/** 分子量候选：饱和/拖尾/重叠只能成为候选或区间，保留全部合法候选 */
export interface MwCandidate {
  candidateId: string;
  bandId: string;
  laneId: string;
  /** 推断分子量（单位跟随 ladder role：bp 或 kDa） */
  quantity: Quantity;
  status: DerivationStatus;
  /** 有效区域：局部标尺必须带有效区域 */
  validRegion: {
    tMinPx: number;
    tMaxPx: number;
    /** 该有效区域覆盖的 ladder 锚点 id */
    ladderEntryIds: string[];
    /** 使用的插值段（点击分子量回到 ladder 点与插值段） */
    segmentId: string;
  };
  /** 区间形式（重叠/饱和时） */
  interval?: { low: number; high: number; unit: string };
  /** 拟合残差（像素） */
  fitResidualPx: number;
  diagnostics: Diagnostic[];
  /** 输入摘要（内容哈希）与父级依赖 */
  inputDigest: string;
  parents: string[];
  paramVersion: string;
  /** 时间基准：派生层双时间戳 */
  logicalClock: number;
  wallTimeUtcIso: string;
  /** 被后续修订局部失效后保留（不删除），标记失效父级 */
  invalidatedBy?: string;
}

export interface LadderAssignment {
  assignmentId: string;
  bandId: string;
  ladderEntryId: string;
  status: 'assigned' | 'missing' | 'ambiguous';
  /** 分配段与残差 */
  segmentId: string;
  residualPx: number;
  alternatives?: { ladderEntryId: string; residualPx: number }[];
  diagnostics: Diagnostic[];
}

export interface CalibrationSegment {
  segmentId: string;
  lowEntryId: string;
  highEntryId: string;
  /** log(分子量) 对弧长 t 的局部线性拟合 */
  slopePerPx: number;
  intercept: number;
  tLowPx: number;
  tHighPx: number;
  fitResidualPx: number;
  /** 微笑弯曲：同高度不等于同分子量，局部段必须声明作用 lane 与 t 有效区 */
  laneId: string;
  valid: boolean;
  invalidReason?: DiagnosticCode;
}

/* ---------------- 事件溯源 ---------------- */

export type EventType =
  | 'projectCreated'
  | 'materialAdded'
  | 'materialSuperseded'
  | 'autoAnalyzed'
  | 'decisionRecorded'
  | 'derivationEmitted'
  | 'branchCreated'
  | 'halfWriteDetected';

export interface GelEventPayloadMap {
  projectCreated: { name: string; casePackVersion?: string };
  materialAdded: { material: Material };
  materialSuperseded: {
    materialKind: MaterialKind;
    subjectId: string;
    newMaterial: Material;
    reason: string;
  };
  autoAnalyzed: {
    imageId: string;
    laneIds: string[];
    bandIds: string[];
    paramVersion: string;
    inputDigest: string;
  };
  decisionRecorded: {
    decision: DecisionType;
    subjectId: string;
    note?: string;
    paramSet?: ParamSet;
    value?: Quantity;
    payload?: Record<string, unknown>;
  };
  derivationEmitted: {
    kind: 'mwCandidate' | 'ladderAssignment' | 'calibrationSegment' | 'invalidation';
    record: unknown;
  };
  branchCreated: { name: string; parentBranch: string; parentEventId: string };
  halfWriteDetected: { stagingUri: string; bytesSeen: number; detail: string };
}

export interface GelEvent<T extends EventType = EventType> {
  eventId: string;
  seq: number;
  branch: string;
  /** 分支上的序号（等价输入得到稳定顺序） */
  branchSeq: number;
  /** 前一事件 id（分支内链表） */
  prevEventId: string | null;
  type: T;
  payload: GelEventPayloadMap[T];
  /** 确定性逻辑时钟 + 真实墙钟时间基准 */
  logicalClock: number;
  wallTimeUtcIso: string;
  /** 内容摘要（不含 eventId） */
  digest: string;
}

export interface ProjectState {
  projectId: string;
  name: string;
  branches: string[];
  /** 每个分支折叠后的最新状态 */
  tip: Record<
    string,
    {
      eventId: string;
      image?: RawImageMaterial;
      orientation?: OrientationMaterial;
      exposure?: ExposureMaterial;
      ladder?: LadderMaterial;
      lanes: Record<string, LaneBoundaryMaterial>;
      bands: Record<string, BandCenterMaterial>;
      candidates: Record<string, MwCandidate>;
      assignments: Record<string, LadderAssignment>;
      segments: Record<string, CalibrationSegment>;
      params: Record<string, ParamSet>;
      diagnostics: Diagnostic[];
      conflicts: { subjectId: string; eventIds: string[]; note?: string }[];
    }
  >;
}

/** 导出包：身份、顺序、分支、决定历史全部自带 */
export interface GelBundle {
  format: 'gel-lane-ruler/bundle';
  formatVersion: 1;
  projectId: string;
  projectName: string;
  exportedAtUtcIso: string;
  events: GelEvent[];
  blobs: { uri: string; sha256: string; mediaType: string; base64: string }[];
  casePack?: CasePackManifestRef;
}

export interface CasePackScenarioRef {
  scenarioId: string;
  branch: string;
  title: string;
}

export interface CasePackManifestRef {
  casePackVersion: string;
  manifestSha256: string;
  scenarios: CasePackScenarioRef[];
}
