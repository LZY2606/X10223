/**
 * 胶道标尺工作台 —— 领域类型定义
 *
 * 分层原则：
 *  - Material（不可变材料）：原图、拍摄方向、曝光、ladder 标称值、lane 边界、条带中心。
 *    全部保留像素级来源 / 原始表示（rawText），派生层才做规范化。
 *  - Event（不可变事件）：材料提交、参数修订、人工决定、分支。内容寻址、带父级依赖。
 *  - Derived（可重算结果）：自动条带候选、局部标尺、分子量候选。带输入摘要、参数版本、父依赖。
 *  - Decision（人工决定）：接受 / 否定 / 人工修订分子量；冲突时保留全部并显式标记。
 */

export type Unit = "bp" | "kDa";

/** 带坐标基准的标量 */
export interface Q {
  value: number;
  unit: Unit;
}

/** 原始图像像素坐标（未做方向变换，左上原点） */
export interface PxPoint {
  x: number;
  y: number;
}

/** 原始图像像素折线 */
export interface PxPolyline {
  pts: PxPoint[];
  coord: "raw-px";
}

export type Orientation = "up" | "right" | "down" | "left";

export interface ImageMaterial {
  kind: "image";
  id: string;
  /** 原始 PNG 字节的内容哈希（sha256） */
  sha256: string;
  width: number;
  height: number;
  channels: 1 | 3;
  filename: string;
  /** 原图以文件形式保存的相对路径（内容寻址） */
  blobPath: string;
}

export interface OrientationMaterial {
  kind: "orientation";
  id: string;
  orientation: Orientation;
  /** 证据备注，例如“加样孔位于图像底部，需旋转180” */
  note?: string;
}

export interface ExposureMaterial {
  kind: "exposure";
  id: string;
  /** 原始表示（保留实验室录入文本，如 "300 ms" / "high gain"） */
  rawText: string;
  exposureMs: number | null;
  gainRaw: string | null;
  /** 像素饱和阈值（0..255），用于判定饱和区 */
  saturationLevel: number;
  saturatedPixelCount?: number;
}

export interface LadderNominal {
  kind: "ladderNominal";
  id: string;
  ladderLaneId: string;
  /** 标称值原始表示，不合法值也原样保留 */
  rawText: string;
  /** 期望顺序（自加样孔起，1 基） */
  ordinal: number;
  /** 规范化分子量；无法转换时为 null，诊断留在原位 */
  q: Q | null;
}

export interface LaneBoundary {
  kind: "laneBoundary";
  id: string;
  laneId: string;
  role: "sample" | "ladder";
  label: string;
  /** 两条边界折线（原始像素），弯曲泳道用密集折线表达 */
  left: PxPolyline;
  right: PxPolyline;
  source: "manual" | "imported";
}

export interface BandCenter {
  kind: "bandCenter";
  id: string;
  laneId: string;
  /** 条带中心，原始像素坐标 */
  at: PxPoint;
  source: "manual" | "imported";
  note?: string;
}

export type Material =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderNominal
  | LaneBoundary
  | BandCenter;

export type MaterialKind = Material["kind"];

export interface DetectParams {
  /** 沿泳道剖面的求峰窗口（像素，弧长） */
  peakWindowPx: number;
  /** 峰值显著阈值（相对背景标准差倍数） */
  zThreshold: number;
  /** 横向采样半宽（像素） */
  halfWidthPx: number;
}

export interface FitParams {
  /** 标尺模型：分段对数插值；另给出全局对数线性拟合作残差参照 */
  model: "piecewise-log";
  /** 外推是否允许；false 时超出最近 ladder 点即 outOfValidRange */
  allowExtrapolation: boolean;
}

export interface ParamsMaterial {
  kind: "params";
  id: string;
  paramSet: "detect" | "fit";
  version: number;
  detect?: DetectParams;
  fit?: FitParams;
  note?: string;
}

export type DecisionVerdict = "accepted" | "rejected";

export interface BandMwDecision {
  kind: "bandMwDecision";
  id: string;
  /** 被决定的自动结果（bandMw）id */
  subjectId: string;
  verdict: DecisionVerdict;
  /** 人工修订的分子量（可选）；保留单位与原始录入 */
  override: { rawText: string; q: Q | null } | null;
  reason?: string;
}

export type Decision = BandMwDecision;
export type DecisionKind = Decision["kind"];

export type EventPayload =
  | { type: "projectCreated"; name: string; description?: string }
  | { type: "materialAdded"; material: Material }
  | { type: "materialSuperseded"; oldMaterialId: string; material: Material }
  | { type: "paramsRevision"; params: ParamsMaterial }
  | { type: "decision"; decision: Decision }
  | { type: "branchCreated"; branchName: string; fromEventId: string; reason: string };

export interface Event {
  id: string;
  projectId: string;
  /** 分支内自加样顺序（1 基） */
  seq: number;
  branch: string;
  parentIds: string[];
  payload: EventPayload;
  /** 确定性逻辑时间戳（ms），由生成器注入 */
  at: number;
}

export interface ProjectMeta {
  id: string;
  name: string;
  description?: string;
  createdAt: number;
  rootBranch: string;
}

export interface ExportBundle {
  format: "gel-ruler-casepack";
  formatVersion: 1;
  /** 导出时使用的规则（内核）版本 */
  kernelVersion: string;
  project: ProjectMeta;
  /** 顶层有序、祖先在前；分支形成 DAG */
  events: Event[];
  /** 内容寻址的图像字节（base64 PNG），键为 sha256 */
  blobs: Record<string, { b64: string; filename: string }>;
  /** 导出时的派生缓存（导入后可重算校验） */
  derivedSnapshot?: DerivedSnapshot;
  exportedAt: number;
}

export interface DerivedSnapshot {
  results: DerivedResult[];
  /** 结果的稳定顺序键（等价输入 → 等价顺序） */
  order: string[];
}

/** 诊断（带位置） */
export interface Diagnostic {
  code:
    | "UNCONVERTIBLE_VALUE"
    | "LADDER_MISSING_BAND"
    | "LADDER_NOMINAL_UNPAIRED"
    | "RULER_NONMONOTONIC"
    | "SATURATED_BAND"
    | "TAILED_BAND"
    | "OVERLAPPING_BANDS"
    | "OUT_OF_VALID_RANGE"
    | "MULTIPLE_CANDIDATES"
    | "NO_SOLUTION"
    | "ORIENTATION_UNSET"
    | "MISSING_IMAGE"
    | "DUPLICATE_SUBJECT";
  severity: "info" | "warning" | "error";
  message: string;
  /** 受影响对象的稳定 id */
  subjectIds: string[];
  /** 像素级位置（原始图像坐标） */
  at?: PxPoint | PxPolyline;
  /** 有效区域（局部标尺），用弧长区间表达 */
  validRange?: { laneId: string; sMin: number; sMax: number; basis: "arc-px" };
}

/** 三种不同的失败结果之一：资源预算耗尽 */
export class BudgetExhaustedError extends Error {
  readonly kind = "budget-exhausted" as const;
  constructor(
    message: string,
    readonly budget: { kind: string; limit: number; used: number },
  ) {
    super(message);
    this.name = "BudgetExhaustedError";
  }
}

/** 三种不同的失败结果之一：格式损坏 */
export class CorruptFormatError extends Error {
  readonly kind = "corrupt-format" as const;
  constructor(
    message: string,
    readonly issues: string[],
  ) {
    super(message);
    this.name = "CorruptFormatError";
  }
}

/** 三种不同的失败结果之一：语义无解 */
export class SemanticNoSolutionError extends Error {
  readonly kind = "semantic-no-solution" as const;
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[],
  ) {
    super(message);
    this.name = "SemanticNoSolutionError";
  }
}
