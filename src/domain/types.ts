import type { Diagnostic } from './diagnostics.js';
import type { Quantity, RawQuantity } from './units.js';

/* ---------- 不可变材料层（像素级来源） ---------- */

export type MaterialKind =
  | 'gel-image'           // 原图（像素 + 变换标记）
  | 'capture-orientation' // 拍摄方向
  | 'exposure'            // 曝光
  | 'ladder-nominal'      // ladder 标称值
  | 'lane-boundary'       // lane 边界
  | 'lane-curve'          // lane 弯曲曲线
  | 'band-center';        // 条带中心（含轮廓，像素级来源）

export interface Material<K extends MaterialKind = MaterialKind> {
  id: string;             // 内容寻址稳定身份
  kind: K;
  content: MaterialContent[K];
  contentHash: string;
}

export interface GelImageContent {
  width: number;
  height: number;
  pixelsB64: string;                 // 灰度像素（0-255），base64
  transform: 'none' | 'rot180';      // 图像自身携带的变换标记（像素级来源的一部分）
  generator?: string;                // 合成来源说明（离线案例包）
}
export interface CaptureOrientationContent {
  wells: 'top' | 'bottom';
  raw: string;                       // 原始表示，如 "wells=top, migration=+y"
}
export interface ExposureContent { ms: Quantity<'ms'>; gain: number; raw: string; }
export interface LadderNominalContent {
  name: string;
  values: RawQuantity[];             // 标称 bp，保留原始表示
}
export interface LaneBoundaryContent {
  laneId: string;
  xRange: [Quantity<'px'>, Quantity<'px'>]; // basis: image-normalized
}
export interface LaneCurveContent {
  laneId: string;
  points: Array<{ x: Quantity<'px'>; dy: Quantity<'px'> }>; // 微笑弯曲：dy 随 x 变化
}
export interface BandCenterContent {
  bandId: string;
  laneId: string;
  x: RawQuantity;   // 像素级来源，保留原始表示
  y: RawQuantity;
  contour: { x0: number; y0: number; x1: number; y1: number }; // 条带轮廓（px, image-raw）
  role: 'ladder' | 'sample';
  nominalBp?: number;   // 仅 ladder 带：对应标称值
  smear?: boolean;      // 拖尾标记
}

export interface MaterialContent {
  'gel-image': GelImageContent;
  'capture-orientation': CaptureOrientationContent;
  'exposure': ExposureContent;
  'ladder-nominal': LadderNominalContent;
  'lane-boundary': LaneBoundaryContent;
  'lane-curve': LaneCurveContent;
  'band-center': BandCenterContent;
}

/* ---------- 计算层（记录输入摘要、参数版本、父级依赖） ---------- */

export type ComputationKind =
  | 'normalize-coordinates'
  | 'fit-lane-curves'
  | 'build-local-ruler'
  | 'infer-band-mw'
  | 'detect-saturation'
  | 'detect-overlap';

export type ComputationStatus = 'ok' | 'candidate' | 'interval' | 'failed';

export interface Computation<R = unknown> {
  id: string;
  kind: ComputationKind;
  paramVersion: string;   // 参数版本
  inputDigest: string;    // 输入摘要（材料身份集合的哈希）
  parents: string[];      // 父级依赖（材料/计算身份）
  status: ComputationStatus;
  result: R;
  diagnostics: Diagnostic[];
}

/* ---------- 条带分子量推断结果 ---------- */

export interface LadderPoint {
  bp: Quantity<'bp'>;
  d: Quantity<'px'>;      // 校正后迁移距离（lane-local）
  x: Quantity<'px'>;      // 归一化图像坐标
  y: Quantity<'px'>;
  residualLog10: number;  // 相对全局半对数回归的残差
}

export interface RulerSegment {
  index: number;
  p0: LadderPoint;
  p1: LadderPoint;
  validRegion: { lo: Quantity<'px'>; hi: Quantity<'px'> }; // 局部标尺必须带有效区域
}

export interface LocalRuler {
  laneId: string;                // 标尺来源泳道（ladder 所在泳道）
  points: LadderPoint[];
  segments: RulerSegment[];
  validRegion: { lo: Quantity<'px'>; hi: Quantity<'px'> };
  degraded: boolean;             // 缺带等导致降级
}

export interface BandEvidence {
  rulerComputationId: string;
  segment: RulerSegment | null;      // 点击分子量可回到 ladder 点与插值段
  correctedD: Quantity<'px'>;        // 扣除泳道弯曲后的迁移距离
  validRegion: { lo: Quantity<'px'>; hi: Quantity<'px'> };
  saturation: { saturated: boolean; peakPixel: number; exposureMs: number };
  overlap: { overlapped: boolean; withBandIds: string[] };
}

export interface BandMwResult {
  bandId: string;
  laneId: string;
  status: ComputationStatus;
  mw?: Quantity<'bp'>;                                  // ok：唯一值
  interval?: { lo: Quantity<'bp'>; hi: Quantity<'bp'> }; // 饱和/拖尾：只能给区间
  candidates?: Array<{ mw: Quantity<'bp'>; reason: string }>; // 重叠等：保留全部合法候选
  evidence?: BandEvidence;
}

/* ---------- 决定层（可修改，全部事件化） ---------- */

export type DecisionAction = 'accept' | 'reject' | 'revise' | 'adjust-param';

export interface Decision {
  id: string;
  seq: number;
  targetId: string;        // 条带身份或计算身份
  action: DecisionAction;
  branch: string;          // 分支：冲突的人工决定各自保留
  payload: { mwBp?: number; note?: string; reviewer?: string; paramVersion?: string };
  supersedes?: string;
}

/* ---------- 事件 ---------- */

export interface EventRec {
  seq: number;
  id: string;
  type: string;   // import | compute | decision | perturb | revise-params | rule | save | export | restore
  payload: unknown;
  prevHash: string;
  hash: string;
}

/* ---------- 反例档案 ---------- */

export type PerturbationKind =
  | 'rotate'               // 旋转图像
  | 'smile'                // 弯曲泳道（微笑）
  | 'missing-ladder-band'  // ladder 缺带
  | 'saturation'           // 饱和区
  | 'overlap'              // 两条带重叠
  | 'non-monotonic-ruler'  // 非单调标尺
  | 'local-invalidation';  // 修订后局部失效

export interface CounterexampleEntry {
  id: string;
  baselineId: string;
  perturbation: PerturbationKind;
  changedSource: { materialId: string; kind: MaterialKind }; // 只改动一个直接来源
  affectedComputations: string[];   // 影响被限制在正确范围的证据
  affectedBands: string[];
  adopted: unknown[];               // 被采纳的结果
  rejected: unknown[];              // 未采纳的结果
  rationaleEvents: EventRec[];      // 机器可读取的判断依据
}
