// ---------- 单位与坐标基准 ----------
export type Unit = 'kDa' | 'bp' | 'px' | 'ms' | 'count';

export interface Quantity {
  value: number;
  unit: Unit;
}

export interface CoordBasis {
  kind: 'image-pixel';
  origin: 'top-left';
  axisY: 'down';
  wells: 'top' | 'left';
}

export const IMAGE_BASIS_TOP: CoordBasis = { kind: 'image-pixel', origin: 'top-left', axisY: 'down', wells: 'top' };
export const IMAGE_BASIS_LEFT: CoordBasis = { kind: 'image-pixel', origin: 'top-left', axisY: 'down', wells: 'left' };

// ---------- 诊断：必须带位置 ----------
export interface Diagnostic {
  path: string;      // 例如 materials/lane-boundaries/lanes/2/curve
  code: string;      // 机器可读码
  message: string;
}

// ---------- 计算结果状态：三种失败必须可区分 ----------
export type ComputeStatus =
  | 'ok'
  | 'incomplete'        // 输入不完整：带位置诊断，不得伪装成功
  | 'budget-exhausted'  // 资源预算耗尽
  | 'corrupt-format'    // 格式损坏
  | 'unsolvable';       // 语义无解（如非单调标尺）

// ---------- 不可变材料层 ----------
export type MaterialKind =
  | 'gel-image'
  | 'capture-meta'
  | 'ladder-nominal'
  | 'lane-boundaries'
  | 'band-centers';

export interface Provenance {
  basis: CoordBasis;
  note: string;
  derivedFrom: string[]; // 父级材料 id（像素级来源链）
}

export interface Material<P = unknown> {
  id: string; // mat_<content-hash>，稳定身份
  kind: MaterialKind;
  label: string;
  seq: number;
  payload: P;
  source: Provenance;
}

// ---------- 材料 payload ----------
export interface GelImagePayload {
  width: number;
  height: number;
  pixels: number[]; // row-major 0..255 灰度
}

export interface CaptureMetaPayload {
  orientation: 'wells-top' | 'wells-left';
  exposureMs: number;
  exposureBasis: { unit: 'ms'; clock: 'camera-shutter' };
}

export interface LadderPoint {
  bandIndex: number;
  mw: Quantity;          // 标称分子量
  yPx: number;           // ladder 泳道内像素 y
}

export interface LadderNominalPayload {
  ladderLaneId: string;
  points: LadderPoint[];
}

export interface LaneSpec {
  laneId: string;
  centerXPx: number;   // 直线部分中心 x
  curveK: number;      // “微笑”弯曲系数：x(y) = centerX + curveK * (y - yRef)^2
  yRefPx: number;
  halfWidthPx: number;
}

export interface LaneBoundariesPayload {
  lanes: LaneSpec[];
}

export interface BandCenter {
  bandId: string;
  laneId: string;
  xPx: number;
  yPx: number;
  intensity: number;   // 0..255 实测峰值
  halfWidthPx: number; // 垂直半宽
}

export interface BandCentersPayload {
  bands: BandCenter[];
}

// ---------- 可修改决定层 ----------
export type DecisionAction = 'accept' | 'reject' | 'adjust-params' | 'override';

export interface Decision {
  id: string; // dec_<seq>
  seq: number;
  targetId: string; // estimate id 或 computation id
  action: DecisionAction;
  rationale: string;
  branch: string; // 冲突决定各自落在分支上，全部保留
  payload: unknown;
  eventId: string;
}

// ---------- 事件层（机器可读、可重放） ----------
export type EventKind =
  | 'import'
  | 'review-confirm'
  | 'param-revision'
  | 'source-change'
  | 'compute'
  | 'decision'
  | 'export'
  | 'note';

export interface GelEvent {
  id: string; // evt_<seq>
  seq: number;
  kind: EventKind;
  summary: string;
  payload: unknown;
  parentIds: string[]; // 依赖的事件 id
  createdAt: string;
}

// ---------- 计算层 ----------
export interface Estimate {
  id: string; // est_<computationSeq>_<bandId>
  bandId: string;
  laneId: string;
  kind: 'point' | 'interval' | 'candidates';
  mw?: Quantity;
  interval?: { lo: Quantity; hi: Quantity };
  candidates?: { mw: Quantity; reason: string }[];
  flags: string[]; // saturated | overlap | tailing | extrapolated
  validity: { yMinPx: number; yMaxPx: number; inside: boolean };
  ladderSegment: { lowerPointIdx: number; upperPointIdx: number } | null;
  failureReason?: string;
}

export interface Computation {
  id: string; // cmp_<seq>
  seq: number;
  kind: 'mw-estimate';
  inputDigest: string;    // 输入摘要（材料 id + 参数 的哈希）
  paramVersion: string;
  parentIds: string[];    // 父级依赖（材料 + 事件）
  status: ComputeStatus;
  estimates: Estimate[];
  diagnostics: Diagnostic[];
  stale: boolean;         // 源数据改动后被局部置失效
}

// ---------- 导出包 ----------
export interface ProjectBundle {
  format: 'gel-ruler-bundle';
  schemaVersion: 1;
  projectId: string;
  exportedAt: string;
  materials: Material[];
  events: GelEvent[];
  decisions: Decision[];
  computations: Computation[];
}

// ---------- 管线参数 ----------
export interface PipelineParams {
  version: string;             // 参数版本，如 "v1"
  saturationThreshold: number; // 0..255
  minSeparationPx: number;     // 重叠判定最小间距
  extrapolationMarginPx: number; // 有效区域外允许多少外推
  budget: number;              // 资源预算：最多处理的条带数
}

export const DEFAULT_PARAMS: PipelineParams = {
  version: 'v1',
  saturationThreshold: 250,
  minSeparationPx: 6,
  extrapolationMarginPx: 8,
  budget: 1000,
};
