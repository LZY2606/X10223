// 胶道标尺工作台 —— 全栈共享类型（浏览器与服务端同一份定义）
// 设计原则：
//  - 材料层（materials）不可变：原图、拍摄方向、曝光、ladder 标称值、lane 边界、band 中心
//    均保留像素级来源；修订 = 追加新材料并标注 supersedes，而非覆盖。
//  - 决定层（events）只追加：每次接受/否定/参数调整生成新事件，可回到任意旧事件。
//  - 所有领域量携带单位或坐标基准；原始表示保留在 raw 字段，派生层才规范化。

export type ISODateTime = string;

/** 坐标基准：所有几何量必须声明相对哪一帧/哪个原点。 */
export interface CoordinateFrame {
  /** 被描述的图像 materialId */
  imageId: string;
  /** 帧的拍摄方向（相对原图顺时针角度，单位 deg）。帧 0 = 原始像素帧。 */
  rotationDeg: number;
  /** 原点：像素坐标 (x=0..width-1, y=0..height-1)，原点位于图像左上角，x 向右、y 向下。 */
  origin: 'top-left';
  unit: 'px';
  width: number;
  height: number;
}

export interface PixelPoint {
  x: number; // px，帧内横坐标
  y: number; // px，帧内纵坐标
}

/** 像素级来源：任何派生几何都能回到原图上的像素片段。 */
export interface PixelSource {
  imageId: string;
  frame: { rotationDeg: number };
  /** 来源片段：点（如 band 中心）、折线（如 lane 边界/中心线）或矩形（如饱和区）。 */
  kind: 'point' | 'polyline' | 'rect';
  points: PixelPoint[];
  /** 人工或自动录入时的原始字符串表示（导入时原样保留）。 */
  rawRepresentation: string;
  /** 采集方式：自动候选 / 人工修订 / 导入材料。 */
  capturedBy: 'auto-candidate' | 'human' | 'import';
  uncertaintyPx?: number;
}

/** 带单位的领域量；无法转换时保留 raw + 诊断，value 为 undefined。 */
export interface Quantity {
  value?: number;
  unit: string;
  raw: string; // 导入时的原始表示
  /** 规范化时使用的转换版本，未规范化时为 null。 */
  conversionVersion?: string | null;
}

// ---------------- 不可变材料层 ----------------

export interface ImageMaterial {
  id: string;
  kind: 'image';
  filename: string;
  mediaType: string;
  width: number;
  height: number;
  /** PNG 字节在数据库 blob 表中的键。 */
  blobKey: string;
  /** 拍摄方向（deg，顺时针）。图像本身不被原地改写，旋转通过帧变换表达。 */
  orientationDeg: number;
  /** 曝光元数据：曝光时间/增益/光源，原始表示保留。 */
  exposure: {
    exposureTimeMsRaw: string | null;
    gainRaw: string | null;
    illuminant: string | null;
    /** 8 位灰度的饱和阈值，参数版本提供默认；显式录入优先。 */
    saturationThreshold: number;
  };
  createdAt: ISODateTime;
}

/** ladder 标称分子量表。 */
export interface LadderMaterial {
  id: string;
  kind: 'ladder';
  laneIndex: number;
  /** 从上到下（迁移距离递增）的标称值，保留原始字符串。 */
  rungs: { nominal: Quantity }[];
  rawRepresentation: string;
  capturedBy: 'auto-candidate' | 'human' | 'import';
  createdAt: ISODateTime;
  /** 修订关系：本材料替代的旧材料（旧材料仍然保留）。 */
  supersedes?: string | null;
}

/** lane 边界：左右两条折线（像素帧内），中心由派生层计算。 */
export interface LaneMaterial {
  id: string;
  kind: 'lane';
  laneIndex: number;
  leftBoundary: PixelSource;
  rightBoundary: PixelSource;
  isLadder?: boolean;
  capturedBy: 'auto-candidate' | 'human' | 'import';
  createdAt: ISODateTime;
  supersedes?: string | null;
}

/** band 中心：像素级点来源。 */
export interface BandMaterial {
  id: string;
  kind: 'band';
  laneIndex: number;
  center: PixelSource;
  /** 自动检测得到的证据：峰高、半高宽、饱和度、重叠组等。 */
  evidence: {
    peakIntensity: number; // 0..255 反色后
    fwhmPx: number;
    saturated: boolean;
    smear: boolean;
    overlapGroupId?: string | null;
    /** 峰轮廓（迁移坐标 -> 强度），用于叠加显示。 */
    profileSample: { m: number; i: number }[];
  };
  status: 'candidate' | 'accepted' | 'rejected';
  capturedBy: 'auto-candidate' | 'human' | 'import';
  createdAt: ISODateTime;
  supersedes?: string | null;
}

export type Material = ImageMaterial | LadderMaterial | LaneMaterial | BandMaterial;
export type MaterialId = string;

// ---------------- 事件层（只追加，含分支） ----------------

export type EventType =
  | 'project-created'
  | 'material-added'
  | 'parameter-revision'
  | 'decision-accept'
  | 'decision-reject'
  | 'decision-adjust'
  | 'decision-conflict'
  | 'computation'
  | 'diagnostic'
  | 'archive-run';

export interface ComputeInputSummary {
  /** 参与计算的材料 id 及其内容哈希。 */
  materials: { id: MaterialId; sha256: string }[];
  /** 关键输入标量的摘要（便于等价输入比对）。 */
  scalarSignature: string;
}

export type DiagnosticSeverity = 'error' | 'warning';

export interface Diagnostic {
  /** 机器可读代码，如 LADDER_NON_MONOTONIC。 */
  code: string;
  severity: DiagnosticSeverity;
  message: string;
  /** 带位置的诊断：材料 / lane / band / 帧坐标。 */
  location?: {
    materialId?: MaterialId;
    laneIndex?: number;
    bandId?: MaterialId;
    segmentId?: string;
    point?: PixelPoint;
  };
  /** 三种不同失败结果之一的分类（见 OutcomeKind）。 */
  outcome?: OutcomeKind;
}

/** 资源预算耗尽、格式损坏、语义无解 —— 必须是三种不同结果。 */
export type OutcomeKind =
  | 'ok'
  | 'resource-budget-exhausted'
  | 'format-corrupt'
  | 'semantic-unsolvable';

export interface ParameterSet {
  version: string; // 规则/参数版本，如 calib-1.0.0
  saturationThreshold: number;
  fwhmSmearFactor: number;
  peakProminence: number;
  /** 局部标尺外推容忍（占迁移跨度的比例），超出即失效。 */
  extrapolationTolerance: number;
  /** 单图最大像素数预算。 */
  maxImagePixels: number;
}

export interface CalibrationSegment {
  id: string;
  ladderBandId: MaterialId;
  nextLadderBandId: MaterialId | null;
  mStart: number; // 迁移坐标（像素弧长），lane 局部
  mEnd: number | null;
  mwStart: number; // bp
  mwEnd: number | null;
  /** 该段在二维胶面上的有效区域多边形（像素，分析帧）。 */
  validRegion: {
    frameRotationDeg: number;
    polygon: PixelPoint[];
    /** 区域来源：rung 区间 + 跨 lane 的弧长分数锚定。 */
    basis: string;
    degraded?: boolean; // 跨缺带外推段
  };
  monotonic: boolean;
}

export interface InferredValue {
  /** 稳定身份：由 band 与标定段身份派生，导入导出保持不变。 */
  id: string;
  bandId: MaterialId;
  laneIndex: number;
  kind: 'point' | 'interval' | 'candidate-set';
  /** 单一推断（bp）；饱和/拖尾/重叠时为空，改用 interval 或 candidates。 */
  mwBp?: number;
  interval?: { lowBp: number; highBp: number; reason: string };
  candidates?: { mwBp: number; basis: string }[];
  /** 该值由哪条插值段支持（点击回溯用）。 */
  segmentId: string | null;
  migrationPx: number;
  /** 相对 log-linear 局部拟合的残差（迁移像素）。 */
  residualPx: number | null;
  qualityFlags: ('saturated' | 'smear' | 'overlap' | 'extrapolated' | 'out-of-range')[];
  status: 'valid' | 'candidate' | 'interval' | 'unresolved';
}

export interface ComputationPayload {
  inputSummary: ComputeInputSummary;
  parameterVersion: string;
  parentDependencies: { eventId: string; sha256: string }[];
  segments: CalibrationSegment[];
  inferred: InferredValue[];
  diagnostics: Diagnostic[];
  outcome: OutcomeKind;
}

export interface ProjectEvent {
  id: string; // 内容寻址
  projectId: string;
  seq: number; // 分支内稳定顺序
  branch: string;
  type: EventType;
  timestamp: ISODateTime;
  /** 父事件（支持分叉：冲突决定从旧父级另开分支）。 */
  parentId: string | null;
  /** 本事件负载的 sha256（不含 id 自身），用于导出链校验。 */
  sha256?: string;
  payload: unknown;
}

// ---------------- 项目与档案 ----------------

export interface ProjectMeta {
  id: string;
  name: string;
  createdAt: ISODateTime;
  headEventId: string | null;
  headBranch: string;
}

export interface ArchiveJudgement {
  code: string;
  message: string;
  expected: string;
  matched: boolean;
  affectedObjectIds: string[];
}

export interface ArchiveEntry {
  id: string;
  label: string;
  scenario:
    | 'rotated-image'
    | 'curved-smile-lanes'
    | 'ladder-missing-band'
    | 'saturated-region'
    | 'overlapping-bands'
    | 'non-monotonic-ruler'
    | 'post-revision-local-invalidation';
  /** 基线：直接来源清单（材料 id + 像素来源哈希）。 */
  baseline: {
    description: string;
    sources: { materialId: string; kind: Material['kind']; pixelSourceHash: string }[];
  };
  /** 只改动的那一个直接来源。 */
  mutation: { materialId: string; fromHash: string; toHash: string; description: string };
  /** 被采纳与未采纳的结果都保留。 */
  acceptedResults: string[];
  rejectedResults: string[];
  judgements: ArchiveJudgement[];
  /** 机器可读的判断依据事件。 */
  ruleEvents: { code: string; evidence: unknown; holds: boolean }[];
}

// ---------------- 导入包 ----------------

/** GSB-GEL-Pack/1：JSONL，逐行原子帧，便于半写恢复。 */
export interface PackHeader {
  format: 'GSB-GEL-Pack';
  formatVersion: 1;
  projectId: string;
  name: string;
  createdAt: ISODateTime;
}
export type PackLine =
  | { type: 'header'; header: PackHeader }
  | { type: 'blob'; key: string; mediaType: string; bytesBase64: string }
  | { type: 'event'; event: ProjectEvent; prevSha256: string | null }
  | { type: 'archive'; entry: ArchiveEntry }
  | { type: 'commit'; eventCount: number; archiveCount: number; digestSha256: string };
