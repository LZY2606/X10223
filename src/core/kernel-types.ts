import type {
  Diagnostic,
  DetectParams,
  FitParams,
  PxPoint,
  Q,
} from "./types.js";

export const KERNEL_VERSION = "kernel-1.0.0";

/** 输入摘要：仅记录重算必需的内容哈希，不内联大对象 */
export interface InputDigest {
  imageSha: string | null;
  orientationId: string | null;
  exposureId: string | null;
  laneIds: string[];
  bandCenterIds: string[];
  ladderNominalIds: string[];
}

export interface ProfilePoint {
  s: number; // 沿中线弧长（审阅坐标像素）
  at: PxPoint; // 审阅坐标像素
  intensity: number; // 0..255，亮带强度
  saturated: boolean;
}

export type BandStatus =
  | "ok"
  | "saturated"
  | "tailed"
  | "overlapped"
  | "saturated+tailed"
  | "saturated+overlapped";

export interface AutoBand {
  kind: "autoBand";
  id: string;
  laneId: string;
  peakS: number;
  peakAt: PxPoint;
  /** 半高全宽（弧长像素） */
  fwhm: number;
  /** 剖面的不对称度：>tailRatio 视为拖尾 */
  tailAsymmetry: number;
  status: BandStatus;
  peakIntensity: number;
  /** 与该候选在同一泳道内重叠的其他候选 */
  overlapsWith: string[];
  /** 该条带中心对应的人工来源条带（若存在，用于自动候选 vs 人工修订对比） */
  matchedManualBandId: string | null;
  inputDigest: InputDigest;
  paramVersion: string;
  kernelVersion: string;
  parentIds: string[];
}

export interface LadderPoint {
  nominalId: string;
  bandCenterId: string | null;
  at: PxPoint | null;
  s: number | null;
  q: Q | null;
  rawText: string;
  ordinal: number;
}

/** 一条局部标尺段（相邻两 ladder 点对数插值），带有效弧长区域 */
export interface RulerPiece {
  id: string;
  laneId: string;
  loNominalId: string;
  hiNominalId: string;
  loBandCenterId: string;
  hiBandCenterId: string;
  loS: number;
  hiS: number;
  loQ: Q;
  hiQ: Q;
  /** 有效区域：仅在 [validSMin, validSMax] 内可信 */
  validSMin: number;
  validSMax: number;
  unit: Q["unit"];
}

export interface RulerResult {
  kind: "ruler";
  id: string;
  ladderLaneId: string;
  points: LadderPoint[];
  pieces: RulerPiece[];
  /** 全局对数线性拟合（仅作残差参照） */
  globalFit: { slope: number; intercept: number } | null;
  /** 每个 ladder 点相对全局拟合的残差（弧长像素） */
  residuals: { nominalId: string; bandCenterId: string; s: number; fittedS: number; residual: number }[];
  diagnostics: Diagnostic[];
  inputDigest: InputDigest;
  paramVersion: string;
  kernelVersion: string;
  parentIds: string[];
}

export interface MwCandidate {
  q: Q;
  /** 区间推断时给出 [lo, hi]；单点时两者相等 */
  qLo: Q;
  qHi: Q;
  /** 引用的标尺段（点击分子量回溯 ladder 点与插值段） */
  rulerPieceId: string | null;
  sourceS: number;
  /** 区间两端对应的弧长 */
  sLo: number;
  sHi: number;
  reason: "unique" | "saturated-range" | "overlap-split" | "tailed-range" | "multiple-pairings";
}

export interface BandMwResult {
  kind: "bandMw";
  id: string;
  laneId: string;
  autoBandId: string;
  bandCenterAt: PxPoint;
  /** 无法唯一决定时保留全部合法候选；否则只有一个 unique 候选 */
  candidates: MwCandidate[];
  unique: boolean;
  status: BandStatus;
  outOfValidRange: boolean;
  diagnostics: Diagnostic[];
  inputDigest: InputDigest;
  paramVersion: string;
  kernelVersion: string;
  parentIds: string[];
}

export type DerivedResult = AutoBand | RulerResult | BandMwResult;

export interface ComputeOptions {
  /** 资源预算：每个泳道采样点上限等 */
  maxSamplesPerLane?: number;
}

export interface ComputeContext {
  detect: DetectParams;
  fit: FitParams;
  opts: Required<ComputeOptions>;
}

export interface Derivation {
  autoBands: AutoBand[];
  rulers: RulerResult[];
  bandMws: BandMwResult[];
  diagnostics: Diagnostic[];
  /** 结果稳定顺序 */
  order: string[];
}
