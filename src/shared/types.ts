/**
 * 共享类型：所有领域量都携带单位或坐标基准。
 * 导入层保留原始表示（raw），派生层才做规范化。
 */

export type Unit = 'bp' | 'px' | 's' | 'ms' | 'kV' | 'log10bp' | 'count';

export interface Quantity {
  value: number;
  unit: Unit;
}

/** 像素点必须声明所在坐标系：原始图像帧或校正帧，并记录变换来源 */
export interface PixelPoint {
  x: number;
  y: number;
  frame: 'image' | 'corrected';
  /** 若经过旋转/翻转等变换，指向变换材料 id */
  transformId?: string;
}

export interface Diagnostic {
  /** 出错位置，如 ladder.bands[3].center，绝不用空值伪装成功 */
  path: string;
  code: string;
  message: string;
}

export type Orientation = '0' | '90cw' | '180' | '270cw';

export interface GelImageMeta {
  widthPx: number;
  heightPx: number;
  orientation: Orientation;
  exposure: { time: Quantity; gain: number };
  grayMax: number;
}

export interface LadderBandNominal {
  size: Quantity; // bp
}

export interface LaneBoundary {
  laneId: string;
  /** 泳道中心线折线（像素级来源，image 帧） */
  centerline: PixelPoint[];
  role: 'ladder' | 'sample';
}

export interface BandCenter {
  bandId: string;
  laneId: string;
  center: PixelPoint;
  /** 人工修订时记录来源事件 */
  sourceEventId?: string;
}

/** 计算结果的三种失败 + 成功，彼此是不同结果类型 */
export type ComputeResult =
  | { status: 'ok'; estimates: Estimate[]; diagnostics: Diagnostic[] }
  | { status: 'incomplete_input'; diagnostics: Diagnostic[] }
  | { status: 'budget_exhausted'; consumedSteps: number; budget: number }
  | { status: 'corrupt_format'; diagnostics: Diagnostic[] }
  | { status: 'semantic_unsolvable'; reason: string; diagnostics: Diagnostic[] };

export type BandClass =
  | { kind: 'point'; s: number }
  | { kind: 'interval'; sLo: number; sHi: number; cause: 'saturated' | 'tailing' | 'overlap' }
  | { kind: 'candidate-group'; candidates: { s: number }[]; cause: 'overlap' };

export interface Estimate {
  id: string;
  bandId: string;
  laneId: string;
  /** 分子量（bp）；区间/候选时不给唯一点值 */
  bp?: Quantity;
  bpInterval?: { lo: Quantity; hi: Quantity };
  candidates?: Quantity[];
  status: 'accepted' | 'candidate' | 'rejected';
  segmentId?: string;
  /** 局部标尺的有效区域（弧长坐标 s，单位 px） */
  validRegion?: { sLo: number; sHi: number };
  invalidReason?: string;
  provenance: {
    materialIds: string[];
    paramsVersion: string;
    parentEventIds: string[];
  };
}

export interface ScaleSegment {
  id: string;
  index: number;
  s0: number;
  s1: number;
  logBp0: number;
  logBp1: number;
  /** ladder 缺带造成的宽间隙段 */
  wideGap: boolean;
}

export interface Scale {
  segments: ScaleSegment[];
  validRegion: { sLo: number; sHi: number };
  ladderPoints: { s: number; bp: number; bandId: string }[];
  residuals: { bandId: string; s: number; nominalBp: number; fittedBp: number; residualLog10: number }[];
}

export interface LanePath {
  laneId: string;
  points: PixelPoint[];
  /** 每个折线顶点的累计弧长（px） */
  arc: number[];
  total: number;
}
