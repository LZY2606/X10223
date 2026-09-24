// 领域类型：所有领域量都携带单位或坐标基准。
// 分层原则：materials = 不可变材料（像素级来源），results = 可重算的派生层，
// events = 可修改决定的历史。导出/导入必须保持身份、顺序与来源关系。

export type Unit = 'px' | 'bp' | 'log10(bp)' | 'ms' | 'ratio' | 'deg' | 'count';

export interface Quantity<U extends Unit = Unit> {
  value: number;
  unit: U;
}

// 坐标基准：raw = 原始像素（未旋转）；oriented = 按拍摄方向校正后；lane-arc = 沿泳道曲线弧长
export type CoordBasis = 'image-raw' | 'image-oriented' | 'lane-arc';

export interface PixelPoint {
  x: Quantity<'px'>;
  y: Quantity<'px'>;
  basis: CoordBasis;
}

export interface ArcPosition {
  s: Quantity<'px'>; // 从加样孔沿泳道曲线的弧长
  laneId: string;
  basis: 'lane-arc';
}

export interface Diagnostic {
  code: string; // 如 outside_validity_region / non_monotonic_scale / saturated_band ...
  severity: 'error' | 'warning' | 'info';
  message: string;
  position?: { laneId?: string; bandId?: string; x?: number; y?: number; s?: number };
}

// ---------- 不可变材料 ----------
export type MaterialType =
  | 'image'        // 原图（像素哈希 + 文件引用）
  | 'orientation'  // 拍摄方向（旋转角、加样孔方位）
  | 'exposure'     // 曝光参数
  | 'ladder'       // ladder 标称值（bp，保留原始表示）
  | 'laneBounds'   // lane 边界（像素折线）
  | 'bandCenters'; // 条带中心（像素点）

export interface Material {
  id: string;            // 稳定身份，如 mat_image
  version: number;       // 源数据改动产生新版本，旧版本保留
  type: MaterialType;
  validFrom: number;     // 生效事件序号
  validTo: number | null;// null = 当前有效
  contentHash: string;   // 输入摘要
  payload: unknown;
}

export interface ImagePayload {
  file: string;          // data/ 下的 PNG 路径
  width: Quantity<'px'>;
  height: Quantity<'px'>;
  grayMax: number;       // 饱和阈值（如 255）
  pixelSource: 'raw-sensor';
}

export interface OrientationPayload {
  rotationDeg: Quantity<'deg'>; // 原始像素 -> 校正方向 的旋转
  wellsAt: 'top' | 'bottom' | 'left' | 'right';
}

export interface ExposurePayload {
  exposureTime: Quantity<'ms'>;
  gain: Quantity<'ratio'>;
  saturated: boolean; // 拍摄时是否已知存在饱和
}

export interface LadderPayload {
  laneId: string;
  nominal: Array<{ id: string; mw: Quantity<'bp'>; raw: string }>; // raw = 导入时原始表示
}

export interface LaneBoundsPayload {
  lanes: Array<{
    id: string;
    kind: 'ladder' | 'sample';
    label: string;
    // 泳道中心线：像素折线（oriented 坐标），保留像素级来源
    centerline: PixelPoint[];
    halfWidth: Quantity<'px'>;
    source: 'manual' | 'auto';
  }>;
}

export interface BandCentersPayload {
  bands: Array<{
    id: string;
    laneId: string;
    center: PixelPoint;   // 像素级来源
    source: 'auto' | 'manual';
    note?: string;
  }>;
}

// ---------- 派生结果 ----------
export type ResultStatus = 'adopted' | 'candidate' | 'interval' | 'ambiguous' | 'invalid' | 'rejected';

export interface Result {
  id: string;          // 稳定身份，如 res_mw_L2_b3
  version: number;
  kind: 'laneCurve' | 'bandCandidate' | 'ladderScale' | 'mwEstimate';
  validFrom: number;
  validTo: number | null;
  inputDigest: string;   // 输入摘要
  paramVersion: string;  // 参数版本
  parents: string[];     // 父级依赖（材料/结果 id+version）
  status: ResultStatus;
  payload: unknown;
  diagnostics: Diagnostic[];
}

export interface LadderSegment {
  id: string;
  upperPointId: string; // ladder 点（靠近加样孔，MW 大）
  lowerPointId: string;
  sRange: [number, number]; // 有效区域（lane-arc px）
  logMwRange: [number, number];
  flags: string[]; // 'spans-missing-band' | 'non-monotonic' ...
}

export interface LadderScalePayload {
  laneId: string;
  points: Array<{ ladderPointId: string; s: number; logMw: number; residual: number }>;
  segments: LadderSegment[]; // 局部标尺，每段带有效区域
  monotonic: boolean;
}

export interface MwEstimatePayload {
  laneId: string;
  bandId: string;
  arc: ArcPosition;                 // 微笑校正后的弧长位置
  rawY: Quantity<'px'>;             // 未校正的原始行高（用于对照）
  mw: Quantity<'bp'> | null;        // 无法唯一决定时为 null + 诊断，绝不用默认值伪装
  mwInterval: [Quantity<'bp'>, Quantity<'bp'>] | null; // 饱和/重叠时给区间
  candidates: Array<{ mw: Quantity<'bp'>; via: string }>; // 保留全部合法候选
  segmentId: string | null;         // 回溯到插值段
  ladderPointIds: string[];         // 回溯到 ladder 点
  validity: { inside: boolean; reason?: string };
  mwFromRawY: Quantity<'bp'> | null; // 不校正微笑时的对照值（证明同一高度≠同一分子量）
}

// ---------- 事件 ----------
export type EventType =
  | 'import' | 'compute' | 'paramRevision' | 'sourceChange'
  | 'decision' | 'export' | 'importProject' | 'checkout';

export interface GelEvent {
  seq: number;
  id: string;
  projectId: string;
  type: EventType;
  parents: string[]; // 事件依赖
  payload: unknown;
  createdAt: string;
}

// 决定：接受/否定/参数调整。机器可读取的判断依据。
export interface DecisionPayload {
  subjectResultId: string;
  action: 'accept' | 'reject' | 'adjust';
  rationaleCode?: string; // 如 smile_local_scale_required / saturated_interval_only
  rationale?: string;
  adjust?: Record<string, number>;
}

export interface Project {
  id: string;
  name: string;
  kind: 'baseline' | 'variant' | 'imported';
  scenario: string; // rotated-image | curved-lanes | ladder-gap | saturation | overlap | non-monotonic | local-invalidation | baseline
  createdSeq: number;
}

// 导入/计算的三种失败必须可区分
export type FailureKind = 'budget_exhausted' | 'format_corrupt' | 'semantic_unsolvable';
export interface Failure {
  kind: FailureKind;
  message: string;
  position?: string; // 带位置的诊断
}
export type Outcome<T> = { ok: true; value: T } | { ok: false; failure: Failure };
