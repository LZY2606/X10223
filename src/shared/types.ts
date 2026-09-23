/**
 * 胶道标尺工作台 —— 共享领域模型
 *
 * 分层：
 *  1. immutable materials：原图、拍摄方向、曝光、ladder 标称值、lane 边界、条带中心
 *     —— 全部携带像素级 provenance；事件流里只能追加新版本，从不就地修改。
 *  2. events：可修改决定（接受/否定/参数调整/人工修订/冲突决定），追加式事件流。
 *  3. derived：由 material 版本 + 参数版本 + 父级依赖确定性重放得到的计算结果。
 *
 * 所有领域量携带单位或坐标基准；规范化只发生在派生层。
 */

export const RULES_VERSION = 'gelbench-rules-1.0.0';

/** 单位族（暴露给界面与导出；原始表示不丢） */
export type Unit =
  | 'bp'            // 碱基对（分子量推断的单位）
  | 'px'            // 像素（图像坐标系）
  | 'lane-arc-px'   // 沿泳道弧长
  | 'gray8'         // 灰度 0..255
  | 'ms'            // 曝光时间
  | 'deg';          // 角度

export interface Qty {
  value: number;
  unit: Unit;
  /** 规范化前的原始表示（导入保真） */
  raw?: string;
}

export type FrameId = 'image' | 'image-rot90' | 'image-rot180' | 'image-rot270';

export interface PixelPoint {
  x: number;
  y: number;
  frame: FrameId;
}

/** 像素级来源：任何可显示的几何值都必须能回到像素点与来源事件 */
export interface Provenance {
  /** 产生该值的源类型 */
  source: 'auto-detect' | 'human' | 'nominal-sheet' | 'derived-transform' | 'synthetic';
  /** 产生该值的事件 id */
  eventId: string;
  /** 依据的像素锚点（条带中心/lane 边界锚点等） */
  anchors?: PixelPoint[];
  /** 人类可读说明，机器判断在别处结构化 */
  note?: string;
}

/** 拍摄方向（不可变材料） */
export interface Orientation {
  /** 相对扫描仪正向的角度（度），仅允许 0/90/180/270 */
  rotationDeg: 0 | 90 | 180 | 270;
  flipH: boolean;
  flipV: boolean;
  provenance: Provenance;
}

export interface Exposure {
  duration: Qty;       // ms
  gain?: Qty;
  /** 饱和灰度阈值（gray8），>= 该值视为饱和候选 */
  saturationGray: Qty;
  provenance: Provenance;
}

export interface ImageMaterial {
  id: string;
  kind: 'gel-image';
  width: number;
  height: number;
  channels: 1;
  /** 8 位灰度原始像素（原始表示；派生层才规范化） */
  pixelsSha256: string;
  orientation: Orientation;
  exposure: Exposure;
  /** 若是旋转产物：父图像与变换 */
  derivedFrom?: {
    parentImageId: string;
    rotate: 0 | 90 | 180 | 270;
    flipH: boolean;
    flipV: boolean;
  };
  provenance: Provenance;
}

export interface LadderNominal {
  rungId: string;
  /** 标称分子量，原始表示（如 "1500 bp"）保留在 raw */
  mw: Qty;
  /** 标称表中的顺序（从大到小） */
  ordinal: number;
  provenance: Provenance;
}

export interface LadderLaneMaterial {
  id: string;
  kind: 'ladder-lane';
  nominals: LadderNominal[];
  provenance: Provenance;
}

export type BandFlag =
  | 'normal'
  /** 饱和：峰顶削平，只能候选/区间 */
  | 'saturated'
  /** 拖尾：单峰但展宽/偏斜，只能候选/区间 */
  | 'tailing'
  /** 重叠：多个峰距小于分辨宽度，只能候选/区间 */
  | 'overlap';

export interface BandObservation {
  id: string;
  laneId: string;
  /** 条带中心像素，frame 标明坐标基准 */
  center: PixelPoint;
  /** 峰顶灰度（gray8） */
  peak: Qty;
  /** 半高宽（像素） */
  fwhm: Qty;
  /** 沿泳道中心线弧长（lane-arc-px，派生几何值，仍标注像素来源） */
  arcS: Qty;
  flag: BandFlag;
  /** 重叠时：该簇内全部候选中心 */
  cluster?: PixelPoint[];
  provenance: Provenance;
}

export interface LaneMaterial {
  id: string;
  index: number;
  role: 'sample' | 'ladder';
  /** 中心线折线（图像像素坐标）。直线 lane 为 2 点。 */
  centerline: PixelPoint[];
  halfWidth: Qty;
  /** 左/右边界锚点，保留独立像素级来源 */
  leftBoundary: PixelPoint[];
  rightBoundary: PixelPoint[];
  provenance: Provenance;
}

export type Material =
  | ImageMaterial
  | LadderLaneMaterial
  | LaneMaterial
  | BandObservation;

/** 标尺参数版本（可修改决定） */
export interface CalibParamsV1 {
  /** 局部标尺有效半区间：只允许在相邻 ladder 点之间内插（lane-arc-px 余量） */
  extrapolationMargin: number;
  /** 重叠分辨宽度（px）：峰距小于此值判为 overlap */
  resolutionWidth: number;
  /** 饱和阈值（gray8），缺省不使用——必须显式给值或由材料给出 */
  saturationGray: number | null;
  /** 拖尾判定：fwhm 相对中位 fwhm 的倍数 */
  tailingRatio: number;
}

export const DEFAULT_CALIB_PARAMS_V1: CalibParamsV1 = {
  extrapolationMargin: 0,
  resolutionWidth: 14,
  saturationGray: 250,
  tailingRatio: 1.8,
};

export type EventType =
  | 'materials_imported'
  | 'image_rotated'
  | 'bands_auto_detected'
  | 'band_added'
  | 'band_removed'
  | 'band_revised'
  | 'lane_revised'
  | 'decision'
  | 'parameter_revised';

export interface MaterialRef {
  materialId: string;
  kind: Material['kind'];
}

export interface EventBase {
  id: string;
  seq: number;
  type: EventType;
  at: string;            // 合成时间戳（确定性，UTC ms）
  branch: string;
  parentEventId: string | null;
  /** 本事件发生时使用的规则版本（历史不被新规则覆盖） */
  rulesVersion: string;
  /** 本事件附带/覆盖的材料（新版本，id 稳定 + version 体现在 provenance） */
  materials?: Material[];
  /** 引用到的既有材料（如旋转源图） */
  refs?: MaterialRef[];
}

export interface MaterialsImportedEvent extends EventBase {
  type: 'materials_imported';
  imageId: string;
  ladderId: string;
  laneIds: string[];
  bandIds: string[];
  /** 导入时的输入摘要（哈希族） */
  inputDigest: InputDigest;
}

export interface ImageRotatedEvent extends EventBase {
  type: 'image_rotated';
  sourceImageId: string;
  newImageId: string;
  rotate: 0 | 90 | 180 | 270;
}

export interface BandsAutoDetectedEvent extends EventBase {
  type: 'bands_auto_detected';
  imageId: string;
  bandIds: string[];
  paramsVersion: number;
}

export interface BandAddedEvent extends EventBase {
  type: 'band_added';
  bandId: string;
}

export interface BandRemovedEvent extends EventBase {
  type: 'band_removed';
  bandId: string;
}

export interface BandRevisedEvent extends EventBase {
  type: 'band_revised';
  bandId: string;
}

export interface LaneRevisedEvent extends EventBase {
  type: 'lane_revised';
  laneId: string;
}

export type DecisionKind = 'accept' | 'reject' | 'interval' | 'conflict';

export interface DecisionEvent extends EventBase {
  type: 'decision';
  kind: DecisionKind;
  /** 被决定的显示槽位稳定 id（band 或 lane 或 calibration） */
  targetSlotId: string;
  /** interval：人工指定的合法区间（bp）；conflict：互斥决定并存 */
  acceptedMw?: number;
  mwInterval?: [number, number];
  reason: string;
  /** 冲突决定：同槽位上互斥的决定集合（全部保留） */
  conflicts?: Array<{ author: string; kind: DecisionKind; mw?: number; interval?: [number, number] }>;
}

export interface ParameterRevisedEvent extends EventBase {
  type: 'parameter_revised';
  paramsVersion: number;
  previousVersion: number;
  /** 只记录变化字段；未变化字段继承 */
  patch: Partial<CalibParamsV1>;
  reason: string;
}

export type GelEvent =
  | MaterialsImportedEvent
  | ImageRotatedEvent
  | BandsAutoDetectedEvent
  | BandAddedEvent
  | BandRemovedEvent
  | BandRevisedEvent
  | LaneRevisedEvent
  | DecisionEvent
  | ParameterRevisedEvent;

/** 输入摘要：每个直接来源都有独立哈希，便于定位是哪条材料造成差异 */
export interface InputDigest {
  imagePixels: string;
  orientation: string;
  exposure: string;
  ladderNominals: string;
  laneGeometry: string;
  bandCenters: string;
  overall: string;
}

export type DiagnosticCode =
  | 'missing-ladder-rung'
  | 'saturated-band'
  | 'tailing-band'
  | 'overlapping-bands'
  | 'non-monotonic-scale'
  | 'outside-valid-region'
  | 'ambiguous-match'
  | 'gap-crossing'
  | 'conflicting-decisions'
  | 'local-invalidation'
  | 'incomplete-input';

export type Severity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  /** 带位置的诊断：像素/弧长/槽位 id，不允许空值伪装成功 */
  at?: {
    slotId?: string;
    pixel?: PixelPoint;
    arcS?: number;
    rungId?: string;
    segmentIndex?: number;
  };
  message: string;
}

/** 局部标尺段：带有效区域的插值段（微笑弯曲的核心） */
export interface CalibSegment {
  index: number;
  rungAId: string;
  rungBId: string;
  /** 弧长区间 [sA,sB]（lane-arc-px），同高度不同 lane 的 s 不同 */
  sA: number;
  sB: number;
  logMwA: number;
  logMwB: number;
  /** 是否单调可内插；非单调段无效 */
  valid: boolean;
  /** 跨缺带 gap 时为 true，区间不确定性更宽 */
  gap: boolean;
  /** 拟合残差（logMw 单位） */
  residual: number;
}

export interface LadderCalibration {
  laneId: string;
  segments: CalibSegment[];
  /** 有效弧长区域（外推被禁止） */
  validS: [number, number];
  rungAssignments: Array<{
    rungId: string;
    ordinal: number;
    nominalMw: number;
    bandId: string;
    arcS: number;
  }>;
  diagnostics: Diagnostic[];
}

export interface BandResult {
  slotId: string;
  bandId: string;
  laneId: string;
  arcS: number;
  center: PixelPoint;
  flag: BandFlag;
  /** 自动候选值（bp）；无法唯一决定时为 null，候选写入 candidates */
  autoMw: number | null;
  /** 全部合法候选（bp），保留无法唯一决定时的所有解 */
  candidates: number[];
  /** 区间推断（bp） */
  interval: [number, number] | null;
  /** 负责解释该值的插值段 index（点击分子量回到这里） */
  segmentIndex: number | null;
  status: 'candidate' | 'accepted' | 'rejected' | 'interval' | 'conflict';
  diagnostics: Diagnostic[];
  /** 轮廓拟合残差（gray 单位） */
  profileResidual: number;
}

export interface DerivedLane {
  laneId: string;
  role: 'sample' | 'ladder';
  /** 泳道曲线拟合残差（px） */
  curveResidual: number;
  bands: BandResult[];
}

/** 一次计算结果信封：输入摘要 + 参数版本 + 父级依赖 */
export interface DerivedEnvelope {
  rulesVersion: string;
  inputDigest: InputDigest;
  paramsVersion: number;
  params: CalibParamsV1;
  /** 父级依赖：用到的各材料 id@version 与父派生信封 */
  dependencies: Record<string, string>;
  parentDerivedEventId: string | null;
  lanes: DerivedLane[];
  calibrations: Record<string, LadderCalibration>;
  diagnostics: Diagnostic[];
  computedAt: string;
}

/** 某个事件重放后的完整快照（只读结论） */
export interface Snapshot {
  projectId: string;
  branch: string;
  eventId: string;
  eventSeq: number;
  currentImageId: string;
  materials: Material[];
  paramsVersion: number;
  params: CalibParamsV1;
  decisions: DecisionEvent[];
  derived: DerivedEnvelope;
}

/** 项目导出束（离线案例包 / 用户导出共用格式） */
export interface BundleV1 {
  format: 'gelbench-bundle';
  bundleVersion: 1;
  exportedAt: string;
  project: {
    id: string;
    name: string;
    caseId?: string;
  };
  events: GelEvent[];
  branchHeads: Record<string, string>;
  /** 像素库：sha256 -> base64 灰度字节（不内联进事件，事件只引用摘要） */
  images: Record<string, { width: number; height: number; base64: string }>;
}

/** 导入结果三态之一：资源耗尽 / 格式损坏 / 语义无解（严格区分） */
export type ImportResult =
  | { outcome: 'imported'; projectId: string; jobId: string; events: number }
  | { outcome: 'format-corrupt'; jobId: string; reason: string; at?: string }
  | { outcome: 'semantic-unsolvable'; jobId: string; diagnostics: Diagnostic[] }
  | { outcome: 'budget-exhausted'; jobId: string; budget: ComputeBudget; used: number };

export interface ComputeBudget {
  /** 最大像素数 */
  maxPixels: number;
  /** 最大事件数 */
  maxEvents: number;
  /** 最大匹配枚举数（ladder 对齐组合爆炸限制） */
  maxMatchings: number;
}

export const DEFAULT_BUDGET: ComputeBudget = {
  maxPixels: 4_000_000,
  maxEvents: 5_000,
  maxMatchings: 4_096,
};
