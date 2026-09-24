// 领域核心类型：电泳凝胶分子量校准工作台
// 约定：所有材料（materials）不可变；派生（computations）记录输入摘要、参数版本与父级依赖；
// 决策与修订只通过追加事件（events）发生。

export const ALGORITHM_VERSION = "gelwb.1.0.0";

export type QuantityUnit =
  | "pixel" // 像素坐标基准：frame 内 (x,y)，原点左上角，x 向右、y 向下
  | "bp" // 碱基对（核酸分子量代理）
  | "kDa" // 蛋白质分子量
  | "ms" // 曝光时间
  | "eV" // 传感器动态范围量化值（0..maxValue）
  | "deg"; // 角度

export interface Quantity {
  value: number;
  unit: QuantityUnit;
}

/** 任何显示量的稳定身份 + 单位/坐标基准 */
export interface TaggedQuantity extends Quantity {
  id: string;
  basis: string; // 坐标或时间基准描述
  validRange?: { min: number; max: number };
  invalidReason?: string;
}

export interface XY {
  x: number;
  y: number;
}

export interface PixelPoint extends XY {
  frame: string; // image material id，坐标基准
  unit: "pixel";
}

/** 像素级来源：对象上每个关键点都能回到具体像素与产生它的材料/计算 */
export interface PixelProvenance {
  point: PixelPoint;
  sourceMaterialId: string;
  sourceEventId: string;
  confidence?: number;
}

export type FrameRole = "auto" | "manual";
export type OrientationTag = "landscape" | "portrait";

/** 不可变：原始凝胶图像。任何旋转都生成新的 imageMaterial，旧图保留。 */
export interface ImageMaterial {
  id: string;
  kind: "image";
  createdAt: number;
  createdByEventId: string;
  parentImageId: string | null;
  pngBase64: string;
  width: number;
  height: number;
  /** 拍摄方向（仪器/审阅者声明），含方向证据 */
  captureOrientation: {
    declared: OrientationTag;
    evidence: string;
    source: FrameRole;
  };
  /** 旋转角（相对原图，deg），变换链可追溯 */
  rotationDeg: number;
  /** 曝光（保留原始表示，规范化只发生在派生层） */
  exposure: {
    raw: string;
    parsed: Quantity | null;
    unit: string | null;
  };
  maxSensorValue: number;
  capturedAt: string | null;
  timeBasis: string;
  note: string;
}

export type LaneRole = "ladder" | "sample";

/** 泳道中心曲线：折线点列，全部像素坐标；弧长 s 作为迁移坐标 */
export interface LaneMaterial {
  id: string;
  kind: "lane";
  eventId: string; // 产生/修订该版本的事件
  parentLaneId: string | null;
  imageId: string;
  ordinal: number; // 稳定序号（按从左到右，等价输入下顺序稳定）
  role: LaneRole;
  label: string;
  source: FrameRole;
  /** 检测/绘制所用边界宽度（像素） */
  halfWidth: number;
  curve: PixelPoint[];
  createdAt: number;
  supersededBy: string | null;
}

export interface LadderNominalEntry {
  id: string;
  /** 原始表示（导入时保留），如 "1500bp" */
  raw: string;
  value: number | null;
  unit: QuantityUnit | null;
  orderFromTop: number; // 标称自上而下次序
}

/** 不可变语义：ladder 标称值材料；修订生成新版本 */
export interface LadderMaterial {
  id: string;
  kind: "ladder";
  eventId: string;
  parentLadderId: string | null;
  laneId: string;
  source: FrameRole;
  name: string;
  entries: LadderNominalEntry[];
  createdAt: number;
  supersededBy: string | null;
}

export type BandKind =
  | "unique"
  | "saturated"
  | "tailed"
  | "overlap"
  | "missing_ladder";

/** 条带：中心为弧长坐标（携带像素来源），饱和/拖尾/重叠证据保留 */
export interface BandMaterial {
  id: string;
  kind: "band";
  eventId: string;
  parentBandId: string | null;
  imageId: string;
  laneId: string;
  ordinalInLane: number;
  source: FrameRole;
  /** 中心弧长（像素，沿泳道曲线）；sLow/sHigh 为饱和或重叠导致的中心不确定区间 */
  s: number;
  sLow: number;
  sHigh: number;
  center: PixelProvenance;
  width: number; // 高斯拟合 sigma（像素）
  amplitude: number;
  peakValue: number;
  bandKind: BandKind;
  /** 饱和像素比例 [0,1] */
  saturationRatio: number;
  /** 拖尾（向下游）长度（像素） */
  tailLength: number;
  /** 重叠伙伴 band id（同泳道） */
  overlapsWith: string[];
  /** 轮廓采样点（沿弧长），供复核叠加与残差图 */
  profile: { s: number; intensity: number; fit: number }[];
  /** 支撑像素（来源像素集合，抽样保存） */
  supportPixels: PixelProvenance[];
  createdAt: number;
  supersededBy: string | null;
  deleted: boolean;
}

export type Material =
  | ImageMaterial
  | LaneMaterial
  | LadderMaterial
  | BandMaterial;
export type MaterialKind = Material["kind"];

/** 算法参数（带版本），只可追加新版本 */
export interface ParamVersion {
  id: string;
  version: number;
  parentId: string | null;
  eventId: string;
  createdAt: number;
  values: WorkbenchParams;
}

export interface WorkbenchParams {
  /** 饱和判定：峰值 >= maxSensorValue * saturationThreshold 视为饱和 */
  saturationThreshold: number;
  /** 条带检测：沿曲线投影的最小相对峰高 */
  bandProminence: number;
  /** 重叠判定：两峰中心距（像素）小于此值视为重叠 */
  overlapDistancePx: number;
  /** 拖尾判定：峰下游残余高于本峰幅度的比例阈值 */
  tailRatio: number;
  /** 外推是否允许（默认不允许：越界只给失效诊断） */
  allowExtrapolation: boolean;
}

export const DEFAULT_PARAMS: WorkbenchParams = {
  saturationThreshold: 0.98,
  bandProminence: 0.12,
  overlapDistancePx: 9,
  tailRatio: 0.18,
  allowExtrapolation: false
};

export type DiagnosticCode =
  | "incomplete_input"
  | "orientation_mismatch"
  | "ladder_missing_band"
  | "ladder_nonmonotonic"
  | "saturated_center"
  | "overlap_unresolved"
  | "tailed_center"
  | "out_of_valid_range"
  | "unit_unconvertible"
  | "format_corrupt"
  | "semantic_impossible"
  | "resource_exhausted";

export type Severity = "error" | "warning" | "info";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  /** 带位置的定位：材料/条带/标称条目与像素点 */
  location?: {
    materialId?: string;
    bandId?: string;
    laneId?: string;
    ladderEntryId?: string;
    pixel?: PixelPoint;
  };
}

/** ladder 锚点：标称值 ↔ ladder lane 上的迁移坐标 */
export interface LadderAnchor {
  id: string;
  ladderEntryId: string;
  bandId: string;
  s: number;
  value: number;
  unit: QuantityUnit;
  pixel: PixelProvenance;
  monotonicViolation: boolean;
}

/** 局部标尺分段（单调锚点之间的线性 log 插值），带有效区域 */
export interface CalibrationSegment {
  id: string;
  anchorAId: string;
  anchorBId: string;
  sMin: number;
  sMax: number;
  logValueA: number;
  logValueB: number;
  /** 拟合残差（像素），供残差叠加层 */
  residuals: { anchorId: string; residualPx: number }[];
}

export interface InvalidInterval {
  sMin: number;
  sMax: number;
  reason: string;
}

export interface LaneCalibration {
  laneId: string;
  ladderMaterialId: string;
  anchors: LadderAnchor[];
  segments: CalibrationSegment[];
  /** 有效迁移区域 [sMin,sMax]；标尺局部失效区间另有失效原因 */
  validRange: { min: number; max: number };
  invalidIntervals: InvalidInterval[];
  /** 全部锚点对全局 log 拟合的残差（像素），供复核叠加残差层 */
  residuals: { anchorId: string; residualPx: number }[];
  diagnostics: Diagnostic[];
}

export type MwStatus =
  | "unique"
  | "candidate"
  | "interval"
  | "out_of_range"
  | "invalid";

/** 单个条带的分子量推断结果（派生层） */
export interface BandResult {
  id: string;
  bandId: string;
  laneId: string;
  imageId: string;
  status: MwStatus;
  /** 唯一值或区间（携带单位） */
  value: number | null;
  valueLow: number | null;
  valueHigh: number | null;
  unit: QuantityUnit | null;
  s: number;
  centerPixel: PixelPoint;
  /** 使用的插值段（点击分子量回到 ladder 点与该段） */
  segmentId: string | null;
  anchorIds: string[];
  validRange: { min: number; max: number } | null;
  invalidReason: string | null;
  /** 无法唯一决定时的全部合法候选 */
  candidates: {
    value: number;
    unit: QuantityUnit;
    segmentId: string;
    bandId: string;
  }[];
  diagnostics: Diagnostic[];
}

export interface ComputationRecord {
  id: string; // 内容寻址：输入摘要+参数+父级依赖
  kind:
    | "lane_detection"
    | "band_detection"
    | "ladder_calibration"
    | "mw_inference";
  algorithmVersion: string;
  paramsId: string;
  inputSummary: string;
  parentDependencies: string[];
  output: unknown;
  diagnostics: Diagnostic[];
}

export interface DecisionRecord {
  id: string;
  eventId: string;
  branch: string;
  targetType: "band" | "ladder" | "lane" | "ruler";
  targetId: string;
  verdict: "accepted" | "rejected";
  note: string;
  conflictsWith: string[];
  suggestedMw: number | null;
  createdAt: number;
}

export interface LaneComputation {
  lane: LaneMaterial;
  calibration: LaneCalibration | null;
  results: BandResult[];
}

export interface ComputedState {
  imageId: string;
  diagnostics: Diagnostic[];
  laneComputations: LaneComputation[];
  computationIds: {
    lanes: string | null;
    bands: Record<string, string>;
    calibration: string | null;
    inference: string | null;
  };
}
