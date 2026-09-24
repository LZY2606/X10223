/** 领域类型：所有领域量都携带单位或坐标基准；原始表示保留在 raw 字段。 */

export type Unit =
  | "px"          // 像素（需配合坐标基准）
  | "bp"          // 碱基对
  | "kDa"         // 千道尔顿
  | "s"           // 秒（曝光）
  | "deg"         // 度（拍摄方向）
  | "count"       // 灰度计数
  | "ratio";      // 无量纲比例

/** 坐标基准：像素坐标的参照系 */
export type CoordBasis =
  | "image-raw"       // 原始图像像素（未旋转）
  | "image-derotated" // 去旋转后的分析坐标
  | "lane-local";     // 泳道局部坐标（沿泳道曲线弧长）

export interface Quantity {
  value: number;
  unit: Unit;
  basis?: CoordBasis;
  /** 原始表示（导入时原样保留，派生层才规范化） */
  raw?: string;
}

export interface Interval {
  lo: number;
  hi: number;
  unit: Unit;
}

export interface Diagnostic {
  code: string;          // 机器可读诊断码
  message: string;
  /** 位置：materialId / laneId / bandId / 字段路径 */
  location?: string;
  severity: "error" | "warning";
}

/** 三种不同失败结果 */
export type FailureKind = "budget-exhausted" | "format-corrupt" | "semantic-unsolvable";

export type Result<T> =
  | { ok: true; value: T; diagnostics: Diagnostic[] }
  | { ok: false; kind: FailureKind; diagnostics: Diagnostic[] };

export const ok = <T>(value: T, diagnostics: Diagnostic[] = []): Result<T> => ({ ok: true, value, diagnostics });
export const fail = (kind: FailureKind, diagnostics: Diagnostic[]): Result<never> => ({ ok: false, kind, diagnostics });

/** 条带证据状态：自动候选 / 人工修订 / 已采纳 / 已否定 */
export type BandStatus = "auto-candidate" | "revised" | "accepted" | "rejected";

/** 条带质量标记：饱和、拖尾、重叠只能标为候选或区间 */
export type BandFlag = "saturated" | "smearing" | "overlap" | "faint" | "ok";

export interface PixelPoint { x: number; y: number }

/** 泳道曲线：折线（像素级来源） */
export interface LaneCurve {
  points: PixelPoint[];   // 从上到下，image-derotated 坐标
  basis: CoordBasis;
}

export interface LaneBoundary {
  laneIndex: number;
  left: PixelPoint[];     // 左边界折线
  right: PixelPoint[];    // 右边界折线
  center: LaneCurve;
  basis: CoordBasis;
}

export interface BandCenter {
  laneIndex: number;
  /** 条带中心（像素级来源，子像素质心） */
  center: PixelPoint;
  /** 条带轮廓（沿泳道方向的强度峰半高宽，像素） */
  halfWidthPx: number;
  peakIntensity: Quantity; // count
  flags: BandFlag[];
  status: BandStatus;
  basis: CoordBasis;
}

/** ladder 标称值（原始表示保留） */
export interface LadderNominal {
  bandIndex: number;       // 从上到下 0..n-1
  size: Quantity;          // bp 或 kDa，raw 保留原始字符串
  /** 人工指派到图像上的 ladder 条带（像素级来源） */
  assignedCenter?: PixelPoint;
}

/** 局部标尺：ladder 锚点 + 有效区域 */
export interface LocalRuler {
  laneIndex: number;                 // 标尺来源 ladder 泳道
  anchors: { yPx: number; logSize: number; sizeRaw: string }[];
  /** 有效区域：该标尺覆盖的泳道索引区间与 y 像素区间 */
  validLanes: [number, number];
  validY: [number, number];
  monotonic: boolean;
}

/** 分子量推断结果 */
export interface MwEstimate {
  kind: "point" | "interval" | "candidates" | "unavailable";
  value?: Quantity;                  // kind=point
  interval?: Interval;               // kind=interval（饱和/拖尾）
  candidates?: Quantity[];           // kind=candidates（重叠等无法唯一决定）
  reason?: string;                   // kind=unavailable 的失效原因
  rulerLane?: number;
  segment?: { loY: number; hiY: number; loSize: string; hiSize: string }; // 插值段
}

/** 计算资源预算 */
export interface Budget {
  maxLanes: number;
  maxBandsPerLane: number;
  maxCandidates: number;
  maxImagePixels: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxLanes: 64,
  maxBandsPerLane: 256,
  maxCandidates: 32,
  maxImagePixels: 64_000_000,
};
