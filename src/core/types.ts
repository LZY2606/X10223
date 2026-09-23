/**
 * 核心领域类型。
 *
 * 分层原则：
 *  - 不可变材料 (Material)：原图、拍摄方向、曝光、ladder 标称值、lane 边界、条带中心，
 *    均保留像素级来源 (pixelSource)，且使用稳定身份 (stableId)。
 *  - 可修改决定 (Decision)：接受/否定候选、参数修订、冲突解决，只能追加事件。
 *  - 派生结果 (Derivation)：记录输入摘要、参数版本与父级依赖；输入不完整返回带位置的诊断。
 */

export type Angle90 = 0 | 90 | 180 | 270;

/** 带物理单位的标量；value 保留导入时的原始表示。 */
export interface PhysicalQuantity {
  /** 规范数值（派生层转换后）；无法转换时为 null 并保留 raw 与诊断。 */
  value: number | null;
  /** 导入时的原始表示，绝不丢弃。 */
  raw: string;
  /** 物理单位，如 bp / Da / kDa / s / px。 */
  unit: string;
  /** 坐标或时间基准（若适用）。 */
  basis?: string;
}

/** 像素坐标，坐标基准固定为 RAW 图像左上原点、x→右、y→下，单位 px。 */
export interface PxPoint {
  x: number;
  y: number;
  basis: 'raw-image-px';
}

/** 以像素表示的折线（lane 中线、lane 边界等），逐点保留来源。 */
export interface PxPolyline {
  points: PxPoint[];
  basis: 'raw-image-px';
}

export interface Exposure {
  /** 曝光时长，单位秒，保留原始表示。 */
  duration: PhysicalQuantity;
  /** 成像增益/ISO 等无量纲设置（原始字符串）。 */
  gainRaw: string | null;
  /** 位深（每通道位数），如 8/16。 */
  bitDepth: number;
  /** 饱和阈值（原始量程，如 8 位为 255）。 */
  saturationLevel: number;
}

export interface Orientation {
  /** 拍摄方向：相对原图顺时针旋转角度（仅 90 度整数倍）。 */
  rotationCw: Angle90;
  /** 是否水平翻转。 */
  flipH: boolean;
  /** 原始记录的方向来源描述。 */
  note: string;
}

/** 像素级来源：每个材料点/区域都可回到原始图像像素。 */
export interface PixelSource {
  /** 来源图像材料 id。 */
  imageId: string;
  /** 多边形（像素坐标）；点中心为单点多边形。 */
  polygon: PxPoint[];
  /** 记录时刻（毫秒，UTC，基准 ISO-8601 由 clock 生成）。 */
  recordedAtMs: number;
  /** 记录者：auto:<detectorVersion> 或 human:<reviewer>。 */
  recorder: string;
  /** 自动候选的置信度 [0,1]，人工录入为 null。 */
  confidence: number | null;
  /** 原始表示（如导入文件中的坐标文本），用于保留来源。 */
  rawRepresentation?: unknown;
}

export type MaterialKind =
  | 'image'
  | 'orientation'
  | 'exposure'
  | 'ladder-spec'
  | 'lane-geometry'
  | 'band-center';

export interface ImageMaterial {
  kind: 'image';
  stableId: string;
  pngBytesHash: string;
  width: number;
  height: number;
  channels: 1 | 3;
  bitDepth: number;
  /** 像素数据：8 位灰度 0..255（原始字节，不含旋转）。 */
  gray: Uint8Array;
  createdAtMs: number;
}

export interface OrientationMaterial {
  kind: 'orientation';
  stableId: string;
  imageId: string;
  rotationCw: Angle90;
  flipH: boolean;
  note: string;
  source: PixelSource;
}

export interface ExposureMaterial {
  kind: 'exposure';
  stableId: string;
  imageId: string;
  exposure: Exposure;
  source: PixelSource;
}

export interface LadderBandNominal {
  /** 标称分子量，带单位，保留原始表示。 */
  nominal: PhysicalQuantity;
  /** 案例包中的顺序号（输入顺序，稳定）。 */
  ordinal: number;
  /** 是否在本次凝胶上缺失（缺带）。 */
  missing: boolean;
  /** 原始表示。 */
  rawRepresentation?: unknown;
}

export interface LadderSpecMaterial {
  kind: 'ladder-spec';
  stableId: string;
  imageId: string;
  laneId: string;
  bands: LadderBandNominal[];
  source: PixelSource;
}

export interface LaneGeometryMaterial {
  kind: 'lane-geometry';
  stableId: string;
  imageId: string;
  /** lane 稳定标识，如 L1..L6。 */
  laneId: string;
  /** 中心折线（像素级，弯曲泳道用多点）。 */
  centerline: PxPolyline;
  /** 左边界折线。 */
  leftBoundary: PxPolyline;
  /** 右边界折线。 */
  rightBoundary: PxPolyline;
  /** 起始端（上样端）在中线上的弧长位置标记（像素）。 */
  originArcPx: number;
  source: PixelSource;
}

export interface BandCenterMaterial {
  kind: 'band-center';
  stableId: string;
  imageId: string;
  laneId: string;
  /** 候选编号（lane 内稳定）。 */
  bandId: string;
  /** 中心像素。 */
  center: PxPoint;
  /** 沿检测方向的轮廓采样（像素弧长 → 强度），用于复核叠加。 */
  profile: { arcPx: number; intensity: number }[];
  /** 是否位于饱和区。 */
  saturated: boolean;
  /** 饱和像素比例 [0,1]。 */
  saturatedFraction: number;
  /** 是否拖尾/弥散。 */
  smear: boolean;
  /** 与其重叠的其他 band id（同一 lane）。 */
  overlapsWith: string[];
  source: PixelSource;
}

export type Material =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderSpecMaterial
  | LaneGeometryMaterial
  | BandCenterMaterial;

export type DecisionType =
  | 'accept-candidate'
  | 'reject-candidate'
  | 'parameter-revision'
  | 'resolve-conflict'
  | 'manual-band'
  | 'manual-ladder-assignment';

export interface DecisionEvent {
  type: DecisionType;
  /** 目标稳定对象（lane/band/ladder 等）。 */
  targetStableId: string | null;
  /** 参数修订的键值，如 { interpolation: 'log-linear' }。 */
  params?: Record<string, unknown>;
  /** 冲突解决：被采纳的候选 id。 */
  acceptedStableId?: string;
  /** 被否定的候选 id 列表。 */
  rejectedStableIds?: string[];
  /** 人工备注。 */
  note?: string;
}

/** 追加式事件；id 为时间+序号+内容派生，导出/导入保持稳定。 */
export interface Event {
  eventId: string;
  parentEventId: string | null;
  /** 分支名：main 或反例分支。 */
  branch: string;
  seq: number;
  atMs: number;
  actor: string;
  kind: 'material-added' | 'decision' | 'computation-requested' | 'export' | 'import';
  material?: Material;
  decision?: DecisionEvent;
  /** 输入摘要（派生事件用）。 */
  inputSummary?: Record<string, unknown>;
  /** 规则/参数版本。 */
  ruleVersion?: string;
}

/** 带位置的诊断。 */
export interface Diagnostic {
  code:
    | 'INCOMPLETE_INPUT'
    | 'FORMAT_CORRUPT'
    | 'SEMANTIC_UNRESOLVABLE'
    | 'BUDGET_EXHAUSTED'
    | 'UNCONVERTIBLE_VALUE'
    | 'OUT_OF_VALID_REGION';
  message: string;
  /** JSON 指针风格的位置，如 /lanes/2/bands/1/center.x。 */
  path: string;
  severity: 'error' | 'warning';
}

/** 有效区间（弧长像素），局部标尺必须带。 */
export interface ValidRegion {
  arcStartPx: number;
  arcEndPx: number;
  basis: 'lane-arc-px';
}

export interface LadderPointView {
  nominal: PhysicalQuantity;
  arcPx: number;
  bandStableId: string | null;
  missing: boolean;
}

/** 一段单调插值区间（相邻两个有效 ladder 点）。 */
export interface CalibrationSegment {
  segmentId: string;
  from: LadderPointView;
  to: LadderPointView;
  validRegion: ValidRegion;
  interpolation: string;
  /** 是否单调；false 时本段不能唯一推断。 */
  monotonic: boolean;
  diagnostics: Diagnostic[];
}

export interface MwCandidate {
  candidateId: string;
  kind: 'point' | 'interval' | 'ambiguous';
  value: PhysicalQuantity | null;
  /** 区间端点（kind=interval/ambiguous 时）。 */
  low?: PhysicalQuantity;
  high?: PhysicalQuantity;
  status: 'candidate' | 'accepted' | 'rejected';
  reasonCodes: string[];
  segmentId: string | null;
  /** 沿 lane 中线的弧长像素。 */
  arcPx: number;
}

export interface BandDerivation {
  bandStableId: string;
  laneId: string;
  arcPx: number;
  /** 同一弧长在原始像素坐标下的位置（用于叠加显示）。 */
  atPoint: PxPoint;
  candidates: MwCandidate[];
  acceptedCandidateId: string | null;
  validRegion: ValidRegion | null;
  diagnostics: Diagnostic[];
  /** 输入摘要：材料哈希 + 参数。 */
  inputSummary: Record<string, unknown>;
  ruleVersion: string;
  parentEventIds: string[];
}

export interface FitResidual {
  ladderBandStableId: string | null;
  arcPx: number;
  observedNominal: number | null;
  fittedNominal: number | null;
  /** log10 残差。 */
  residualLog10: number | null;
  unit: string;
}

export interface CalibrationDerivation {
  laneId: string;
  ladderLaneId: string;
  segments: CalibrationSegment[];
  residuals: FitResidual[];
  diagnostics: Diagnostic[];
  inputSummary: Record<string, unknown>;
  ruleVersion: string;
  parentEventIds: string[];
}

export interface ProjectState {
  projectId: string;
  createdAtMs: number;
  events: Event[];
  /** 分支头事件 id。 */
  branchHeads: Record<string, string | null>;
}
