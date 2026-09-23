// 共享领域类型：单位、坐标基准、来源、诊断、四态结果。
// 仅使用可擦除语法（node --experimental-strip-types 可直接运行）。

export type Unit = 'px' | 'bp' | 'log10(bp)' | 's' | 'ISO' | 'ratio';

/** 坐标基准：所有像素量都声明自己的参照系，导入时保留原始表示。 */
export type CoordBasis =
  | 'image-px:origin-top-left,y-down' // 原图像素坐标
  | 'image-px:origin-top-left,y-down,rotated-90cw' // 旋转后未回正的原始表示
  | 'lane-local:px-along-curve'; // 沿泳道曲线的局部坐标

export interface Quantity {
  value: number;
  unit: Unit;
  basis?: CoordBasis;
}

/** 像素级来源：每个材料都说明自己来自哪张图的哪个像素/区间。 */
export type Source =
  | { kind: 'pixel'; imageId: string; x: number; y: number }
  | { kind: 'interval'; imageId: string; axis: 'x' | 'y'; lo: number; hi: number }
  | { kind: 'derived'; from: string[] } // from = 材料/事件 id
  | { kind: 'nominal'; ref: string }; // 厂商标称值等外部声明

export interface Diagnostic {
  code: string;
  severity: 'info' | 'warning' | 'error';
  message: string;
  /** 诊断必须带位置，不允许无定位的裸错误。 */
  position: { x?: number; y?: number; laneId?: string; materialId?: string; segmentId?: string };
}

/**
 * 四态结果：成功 / 资源预算耗尽 / 格式损坏 / 语义无解。
 * 三者是互不相同的失败，调用方不得用空值或默认值伪装成功。
 */
export type Outcome<T> =
  | { status: 'ok'; value: T; diagnostics: Diagnostic[] }
  | { status: 'budget_exhausted'; diagnostics: Diagnostic[] }
  | { status: 'format_corrupt'; diagnostics: Diagnostic[] }
  | { status: 'semantic_unsolvable'; diagnostics: Diagnostic[] };

export function ok<T>(value: T, diagnostics: Diagnostic[] = []): Outcome<T> {
  return { status: 'ok', value, diagnostics };
}
export function fail<T>(status: 'budget_exhausted' | 'format_corrupt' | 'semantic_unsolvable', diagnostics: Diagnostic[]): Outcome<T> {
  return { status, diagnostics };
}

/** 计算预算：每步递减，耗尽即 budget_exhausted，绝不截断后冒充完整结果。 */
export interface Budget {
  steps: number;
}
export function spend(budget: Budget, n = 1): boolean {
  if (budget.steps < n) return false;
  budget.steps -= n;
  return true;
}

export interface GelImage {
  width: number;
  height: number;
  /** 8-bit 灰度，行优先，origin 左上，y 向下。 */
  pixels: Uint8Array;
}

export interface LaneDef {
  id: string;
  xCenter: number; // px
  halfWidth: number; // px
  source: Source;
}

export interface LadderPoint {
  sizeBp: number; // 标称分子量
  yPx: number; // 实测条带中心（图像坐标）
  source: Source;
}

export interface RulerSegment {
  id: string;
  yLo: number; // px，较小 y（大分子侧）
  yHi: number; // px
  logLo: number; // log10(bp)，对应 yLo
  logHi: number; // log10(bp)，对应 yHi
  /** 该段跨越了缺失的标称带 → 插值可信度降低，但仍可给出区间。 */
  gap: boolean;
}

export interface Ruler {
  id: string;
  paramVersion: string;
  points: LadderPoint[];
  segments: RulerSegment[];
  /** 有效区域：只有落在 [yMin,yMax] 内的推断才是点估计。 */
  validY: { yMin: number; yMax: number };
  /** 全局 log10(bp) = a + b*y 回归（用于残差展示与全局模式）。 */
  global: { a: number; b: number; residuals: { yPx: number; sizeBp: number; residual: number }[] };
}

export type BandKind = 'point' | 'saturated' | 'overlap' | 'smear';

export interface BandCandidate {
  id: string;
  laneId: string;
  centerPx: number; // 沿图像 y（未旋转坐标系）
  kind: BandKind;
  /** 饱和/拖尾/重叠时只能给区间。 */
  intervalPx?: [number, number];
  /** 重叠时保留全部合法候选中心。 */
  alternativesPx?: number[];
  source: Source;
}

export type MwEstimate =
  | { kind: 'value'; sizeBp: number; logSize: number; segmentId: string; within: boolean }
  | { kind: 'interval'; loBp: number; hiBp: number; reason: 'saturated' | 'overlap' | 'smear' | 'out-of-range' }
  | { kind: 'candidates'; options: { sizeBp: number; segmentId: string }[]; reason: 'overlap' }
  | { kind: 'undecidable'; reason: string };

export interface ParamSet {
  version: string;
  interpolation: 'global-log-linear' | 'local-piecewise';
  saturationValue: number; // 灰度饱和阈值
  minPeakSeparationPx: number;
  peakThreshold: number; // 相对背景的峰值阈值
}
