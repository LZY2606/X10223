// 派生层（可重放证据）：检测、校准、推断。全部携带输入摘要、参数版本、父级依赖。
import type { Diagnostic, GelParams, Quantity, Vec2 } from "./types";

export interface InputSummary {
  image: { width: number; height: number; digest: string; saturated: boolean };
  laneId: string;
  bandCenterCount?: number;
}

export interface ProvenanceNode {
  id: string;
  kind: "detection" | "calibration" | "estimate";
  paramsVersion: string;
  inputSummary: InputSummary;
  parentIds: string[];
  /** 被采纳(true)/未采纳(false) 的结构化判定事件在状态层引用此 id */
  adopted: boolean;
}


export interface DetectedBandView {
  id: string;
  s: number;
  center: Vec2;
  contour: Vec2[];
  peakIntensity: number;
  widthS: number;
  issues: string[];
  saturated: boolean;
}

export interface DetectionArtifact extends ProvenanceNode {
  kind: "detection";
  laneId: string;
  bands: DetectedBandView[];
  noiseLevel: number;
  profile: { s: number; intensity: number }[];
  opsUsed: number;
}

export interface DetectedRungView {
  order: number;
  label: string;
  nominalDa: number | null;
  s: number | null; // null = 标称有但胶上缺带
  matched: boolean;
}

export interface RulerSegment {
  sLow: number;
  sHigh: number;
  mwLowDa: number;
  mwHighDa: number;
  /** 分段是否跨越了缺失 ladder 档（区间可信度下降） */
  spansMissingRung: boolean;
}

export interface CalibrationResult extends ProvenanceNode {
  kind: "calibration";
  laneId: string;
  ladderSpecId: string;
  valid: boolean;
  rungs: DetectedRungView[];
  segments: RulerSegment[];
  /** 局部标尺有效区域（弧长，像素）；微笑泳道每 lane 独立 */
  validRange: { sMin: number; sMax: number } | null;
  residuals: RungResidual[];
  globalFit: { slope: number; intercept: number; r2: number };
  diagnostics: Diagnostic[];
  /** 无法唯一配准时保留全部合法候选配准 */
  candidateAlignments?: { rungs: DetectedRungView[]; cost: number }[];
}

export interface RungResidual {
  order: number;
  label: string;
  sObserved: number;
  sPredicted: number;
  residualPx: number;
}

export interface MwOption {
  nominal: Quantity;
  da: number;
  segmentIndex: number;
  inValidRange: boolean;
  method: "localPiecewise" | "interval" | "globalFitFallback";
}

export interface BandEstimate extends ProvenanceNode {
  kind: "estimate";
  bandId: string;
  laneId: string;
  s: number;
  /** 唯一推断结果；不唯一时为空 */
  point?: MwOption;
  /** 合法候选（重叠双带 / 配准歧义时保留全部） */
  candidates: MwOption[];
  /** 区间结果（饱和/拖尾/跨缺带段） */
  interval?: { low: MwOption; high: MwOption };
  status: "unique" | "candidate" | "interval" | "invalid";
  issues: string[];
  diagnostics: Diagnostic[];
  calibrationId: string;
  /** 点击分子量回溯到的 ladder 点与插值段 */
  evidence: { rungOrders: number[]; segmentIndex?: number; s: number };
}

export interface ParamsRef {
  params: GelParams;
}
