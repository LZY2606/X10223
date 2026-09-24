import type { Diagnostic } from './diagnostic';
import type { DisplayTransform, PixelPoint, PixelWindow, Quantity } from './units';

/**
 * 领域模型分层：
 *  Layer 0 不可变材料（原图、拍摄方向、曝光、ladder 标称、泳道边界、条带中心，全部带像素级来源）
 *  Layer 1 派生结果（校准段、分子量估计），记录输入摘要、参数版本与父级依赖
 *  Layer 2 审阅决定（接受/否定/参数调整），以事件追加，永不改写历史
 */

export interface Provenance {
  /** 来源图像与坐标系 */
  imageId?: string;
  frame?: 'image' | 'display';
  /** 像素级来源窗口 */
  pixelWindow?: PixelWindow;
  /** 产生该对象的事件（决定/修订可回溯到事件） */
  eventId?: string;
  /** 人工修订时指向被修订的对象 */
  revisedFromId?: string;
  note?: string;
}

/* ---------- Layer 0: 不可变材料 ---------- */

export interface ImageAsset {
  id: string;
  kind: 'image-asset';
  file: string;          // 相对 casepack 的路径
  sha256: string;
  width: Quantity<'px'>;
  height: Quantity<'px'>;
  capturedAt: string;    // ISO 时间基准
  provenance: Provenance;
}

export interface CaptureObservation {
  id: string;
  kind: 'capture-observation';
  imageId: string;
  /** 拍摄方向：观察属性，不改写原始像素 */
  orientation: DisplayTransform;
  exposure: {
    timeMs: Quantity<'ms'>;
    gain: number;
    saturatedPixels: Quantity<'count'>;
    saturating: boolean;
  };
  provenance: Provenance;
}

export interface LadderFragment {
  size: Quantity<'bp'>;
  /** 标称顺序：从胶顶（大分子）到胶底 */
  ordinal: number;
}

export interface LadderNominal {
  id: string;
  kind: 'ladder-nominal';
  laneIndex: number;
  name: string;
  fragments: LadderFragment[];
  provenance: Provenance;
}

export interface LaneObservation {
  id: string;
  kind: 'lane-observation';
  laneIndex: number;
  role: 'ladder' | 'sample';
  /** 泳道中心线：image 坐标系下的有序像素折线（允许弯曲） */
  centerline: PixelPoint[];
  /** 泳道边界 */
  boundary: { left: PixelPoint[]; right: PixelPoint[] };
  provenance: Provenance;
}

export interface BandObservation {
  id: string;
  kind: 'band-observation';
  laneIndex: number;
  /** 案例包内稳定标签，如 L2B1 */
  label?: string;
  /** 条带中心：像素级来源 */
  center: PixelPoint;
  halfWidthPx: Quantity<'px'>;
  halfHeightPx: Quantity<'px'>;
  peakIntensity: number;      // 0..1 归一化
  saturated: boolean;
  /** 与相邻条带重叠（只能作为候选） */
  overlapping: boolean;
  /** 拖尾（只能作为候选/区间） */
  trailing: boolean;
  provenance: Provenance;
}

export type Material =
  | ImageAsset
  | CaptureObservation
  | LadderNominal
  | LaneObservation
  | BandObservation;

/* ---------- 参数版本 ---------- */

export interface ParamSet {
  version: string;            // 如 "params/v3"
  interpolation: 'log-linear-piecewise';
  minLadderPoints: number;
  saturationThreshold: number;
  overlapMinSeparationPx: number;
  detectionBudget: { maxPixels: number; maxLanes: number };
}

export const DEFAULT_PARAMS: ParamSet = {
  version: 'params/v1',
  interpolation: 'log-linear-piecewise',
  minLadderPoints: 3,
  saturationThreshold: 0.98,
  overlapMinSeparationPx: 6,
  detectionBudget: { maxPixels: 2_000_000, maxLanes: 64 },
};

/* ---------- Layer 1: 派生结果 ---------- */

export interface CalibrationSegment {
  id: string;
  kind: 'calibration-segment';
  ladderLaneIndex: number;
  /** 段两端 ladder 点（像素级来源可回溯） */
  lower: { bandId: string; rf: number; sizeBp: number };
  upper: { bandId: string; rf: number; sizeBp: number };
  /** log10(bp) = slope * rf + intercept */
  slope: number;
  intercept: number;
  /** 有效区域：仅 [rfMin, rfMax] 内可插值，区间外一律不外推 */
  validRange: { rfMin: number; rfMax: number };
  residual: number;
  ladderPointIds: string[];
  provenance: Provenance;
}

export type MwStatus = 'ok' | 'candidate' | 'interval' | 'invalid';

export interface MwEstimate {
  id: string;
  kind: 'mw-estimate';
  bandId: string;
  laneIndex: number;
  /** 沿本泳道中心线的弧长归一化迁移率（微笑弯曲下不同泳道同一 y 对应不同 rf） */
  rf: number;
  status: MwStatus;
  valueBp?: number;
  intervalBp?: [number, number];
  /** 使用的插值段（点击分子量可回溯） */
  segmentId?: string;
  ladderPointIds: string[];
  /** 全部合法候选（无法唯一决定时全部保留） */
  candidates?: { valueBp: number; segmentId: string }[];
  diagnostics: Diagnostic[];
  provenance: Provenance;
}

export type Derived = CalibrationSegment | MwEstimate;

/* ---------- Layer 2: 审阅决定 ---------- */

export interface DecisionRecord {
  id: string;
  kind: 'decision';
  subjectId: string;         // 被接受/否定的派生结果或候选
  action: 'accept' | 'reject' | 'adjust-param' | 'exclude-band' | 'revise-observation';
  rationale: string;
  actor: string;
  payload?: unknown;
  provenance: Provenance;
}

/* ---------- 事件日志（可重放、可回溯） ---------- */

export type EventKind =
  | 'import-casepack'
  | 'observe'
  | 'scenario'          // 边界情形注入（旋转/弯曲/缺带/饱和/重叠/非单调/局部失效）
  | 'recompute'
  | 'param-change'
  | 'source-revision'   // 只影响局部依赖的源数据改动
  | 'decision'
  | 'export'
  | 'import';

export interface WorkEvent {
  id: string;
  seq: number;
  projectId: string;
  branchId: string;
  parents: string[];         // 父事件 id（分支合并时为多个）
  kind: EventKind;
  actor: string;
  /** 输入摘要：稳定哈希，等价输入 => 等价摘要 => 稳定顺序 */
  inputsSummary: string;
  paramsVersion: string;
  payload: unknown;
}

export interface ProjectState {
  projectId: string;
  name: string;
  branches: { id: string; name: string; headEventId: string }[];
  materials: Material[];
  derived: Derived[];
  decisions: DecisionRecord[];
  events: WorkEvent[];
  diagnostics: Diagnostic[];
}
