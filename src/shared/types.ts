/**
 * 领域模型：不可变材料（materials）与可修改决定（decisions）分层。
 * 所有领域量携带单位或坐标基准；像素级来源不可变。
 */

export type Unit = "bp" | "px" | "ms" | "deg" | "ratio";

export interface Quantity {
  value: number;
  unit: Unit;
}

/** 坐标基准：raw 为原始拍摄像素；derived 为规范化（旋转校正后）坐标。 */
export type Frame = "raw" | "derived";

export interface PixelPoint {
  x: Quantity; // px
  y: Quantity; // px
  frame: Frame;
}

/** 像素级来源：任何从图像读出的量都指向它。 */
export interface PixelSource {
  imageId: string;
  frame: Frame;
  point: PixelPoint;
  /** 取源时的图像内容摘要，防止来源被静默替换。 */
  imageDigest: string;
}

export type MaterialKind =
  | "gel-image"
  | "capture-orientation"
  | "exposure"
  | "ladder-nominal"
  | "lane-boundary"
  | "band-center";

/** 不可变材料：导入后只读，任何修改都产生新材料（分支）。 */
export interface Material {
  id: string;
  kind: MaterialKind;
  projectId: string;
  /** 原始表示（导入时原样保留，派生层才做规范化）。 */
  raw: Record<string, unknown>;
  /** 规范化后的领域值；无法转换时为空并附诊断。 */
  normalized?: Record<string, unknown>;
  source?: PixelSource;
  digest: string;
  seq: number; // 稳定顺序
  createdAt: string;
  /** 若由另一材料派生（如旋转后的图像），记录父级。 */
  parentMaterialId?: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  /** 出错位置：材料 id / 字段路径 / 像素坐标。 */
  location: { materialId?: string; field?: string; point?: PixelPoint };
  severity: "error" | "warning";
}

export type BandStatus =
  | "auto-candidate" // 自动候选
  | "accepted" // 人工采纳
  | "rejected" // 人工否定
  | "interval-only" // 只能给区间（饱和/拖尾/重叠）
  | "invalidated"; // 修订后局部失效

export interface LaneCurvePoint {
  /** 沿泳道前进方向的位置（px, derived 坐标）。 */
  s: number;
  /** 泳道中心线横向偏移（px, derived 坐标）。 */
  offset: number;
}

export interface FitSegment {
  id: string;
  laneId: string;
  /** 插值段两端 ladder 点（材料 id）。 */
  lowerLadderMaterialId: string;
  upperLadderMaterialId: string;
  /** 有效区域：泳道 + 迁移距离区间 + 分子量区间。 */
  validity: {
    laneId: string;
    sMin: Quantity; // px
    sMax: Quantity; // px
    mwMin: Quantity; // bp
    mwMax: Quantity; // bp
  };
  /** log10(bp) 对 s 的线性插值参数。 */
  slope: number;
  intercept: number;
  residual: number; // 段内拟合残差（log10 bp）
  status: "valid" | "non-monotonic" | "missing-anchor" | "invalidated";
  invalidReason?: string;
}

export interface MwEstimate {
  id: string;
  bandMaterialId: string;
  laneId: string;
  /** 点估计；区间情形为 null。 */
  mw: Quantity | null;
  /** 区间估计（饱和/拖尾/重叠/无法唯一决定）。 */
  interval?: { lo: Quantity; hi: Quantity };
  /** 候选集合：无法唯一决定时保留全部合法候选。 */
  candidates?: Array<{ mw: Quantity; viaSegmentId: string }>;
  viaSegmentId?: string;
  status: BandStatus;
  diagnostics: Diagnostic[];
}

/** 计算记录：输入摘要 + 参数版本 + 父级依赖。 */
export interface ComputationRecord {
  id: string;
  projectId: string;
  ruleVersion: string;
  /** 参数版本：计算所用参数集合的摘要。 */
  paramVersion: string;
  params: Record<string, unknown>;
  inputDigest: string;
  parentEventId?: string;
  dependsOnMaterialIds: string[];
  dependsOnDecisionIds: string[];
  segments: FitSegment[];
  estimates: MwEstimate[];
  diagnostics: Diagnostic[];
  createdAt: string;
}

export type DecisionAction = "accept" | "reject" | "adjust-param" | "mark-interval";

export interface Decision {
  id: string;
  projectId: string;
  action: DecisionAction;
  targetMaterialId?: string;
  targetEstimateId?: string;
  payload: Record<string, unknown>;
  rationale: string;
  createdAt: string;
}

/** 机器可读取事件：导入/计算/决定/修订/导出全部走事件日志。 */
export interface DomainEvent {
  id: string;
  projectId: string;
  seq: number;
  type:
    | "material-imported"
    | "computation-run"
    | "decision-recorded"
    | "material-superseded"
    | "export-created"
    | "import-applied"
    | "counterexample-case";
  /** 事件负载：含判定状态、受影响对象、输入片段。 */
  payload: Record<string, unknown>;
  computationId?: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  createdAt: string;
}

/** 反例档案条目：基线 + 单一变量扰动 + 影响范围断言。 */
export interface CounterexampleCase {
  id: string;
  title: string;
  baselineDigest: string;
  perturbation: string;
  affectedScope: { materialIds: string[]; segmentIds: string[]; estimateIds: string[] };
  adoptedEstimateIds: string[];
  rejectedEstimateIds: string[];
  events: DomainEvent[];
}

/** 三种必须区分的失败结果。 */
export type Outcome<T> =
  | { kind: "ok"; value: T }
  | { kind: "budget-exhausted"; spent: number; budget: number }
  | { kind: "format-corrupt"; diagnostics: Diagnostic[] }
  | { kind: "semantic-unsolvable"; diagnostics: Diagnostic[] };
