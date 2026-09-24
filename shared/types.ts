// ---------- 诊断与结果 ----------
export type Severity = 'error' | 'warning';

export interface Diagnostic {
  code: string;          // 机器可读码，如 INCOMPLETE_INPUT / UNIT_UNKNOWN
  message: string;
  path: string;          // 出错位置，如 materials[lane-boundary:L2].points[1]
  severity: Severity;
}

export type FailureKind =
  | 'BUDGET_EXHAUSTED'       // 资源预算耗尽
  | 'FORMAT_CORRUPT'         // 格式损坏
  | 'SEMANTIC_UNSOLVABLE'    // 语义无解（如非单调标尺段内求值）
  | 'INCOMPLETE_INPUT'       // 输入不完整
  | 'OUT_OF_VALID_REGION';   // 超出局部标尺有效区域

export type Status = 'ok' | 'candidate' | 'interval' | 'failed';

export interface Failure {
  kind: FailureKind;
  message: string;
  path: string;
}

export type Result<T> =
  | { ok: true; value: T; diagnostics: Diagnostic[] }
  | { ok: false; failure: Failure; diagnostics: Diagnostic[] };

// ---------- 单位与坐标基准 ----------
export type Unit = 'px' | 'bp' | 'log10bp' | 'ms' | 'deg' | 'rf' | 'intensity';
export type Basis =
  | 'image-top-left'   // 像素坐标，原点左上，y 向下
  | 'lane-rf'          // 相对迁移率 0..1（well->front）
  | 'capture'          // 拍摄参数
  | 'nominal';         // 标称值

export interface Quantity {
  raw: string;            // 导入时的原始表示，永不丢失
  value: number | null;   // 规范化后的值；无法转换时保持 null 并附诊断
  unit: Unit | null;
  basis: Basis;
  diagnostic?: Diagnostic;
}

// ---------- 不可变材料层 ----------
export type MaterialKind =
  | 'image'            // 原始凝胶图像（合成规格 + 像素摘要）
  | 'capture'          // 拍摄方向与曝光
  | 'ladder-nominal'   // ladder 标称值
  | 'lane-boundary'    // lane 边界（像素级来源）
  | 'band-center';     // 条带中心（像素级来源）

export interface PixelPoint { x: number; y: number; }

export interface Material {
  id: string;            // 内容寻址: mat:<kind>:<sha256[:16]>
  kind: MaterialKind;
  payload: Record<string, unknown>;
  provenance: {          // 像素级来源
    pixelPoints?: PixelPoint[];
    sourceMaterialIds?: string[];
    note?: string;
  };
  digest: string;
  branch: string;
  createdSeq: number;
  supersedes?: string;   // 修订链：新材料指向被替换的旧材料
}

// ---------- 参数版本 ----------
export interface ParamSet {
  id: string;            // par:<sha256[:16]>
  version: string;       // 人类可读版本，如 fit-v1
  payload: {
    model: 'log-linear';
    saturationThreshold: number;   // 强度阈值，>= 视为饱和
    overlapResolutionPx: number;   // 小于该距离视为重叠
    maxBandsPerLane: number;       // 资源预算
    wellY: number;                 // 加样孔 y（rf=0）
    frontY: number;                // 前沿 y（rf=1）
  };
  createdSeq: number;
}

// ---------- 派生计算层 ----------
export type ComputationKind =
  | 'lane-curve'       // 泳道中线 x(y)
  | 'band-candidates'  // 自动条带候选
  | 'mw-fit'           // ladder 全局拟合
  | 'local-ruler'      // 局部标尺（带有效区域）
  | 'mw-estimate';     // 条带分子量推断

export interface ValidRegion {
  laneId?: string;
  segmentId?: string;
  rfMin: number;
  rfMax: number;
  basis: Basis;
}

export interface Computation {
  id: string;            // cmp:<kind>:<sha256(inputDigest+payload)[:16]>
  kind: ComputationKind;
  inputDigest: string;   // 输入摘要：排序后的父级 id + 参数版本
  parents: string[];     // 父级依赖（材料或计算 id）
  paramVersion: string;
  status: Status;
  payload: Record<string, unknown>;
  validRegion?: ValidRegion;
  failure?: Failure;
  branch: string;
  createdSeq: number;
}

// ---------- 可修改决定层 ----------
export type DecisionAction = 'accept' | 'reject' | 'adjust';

export interface Decision {
  id: string;            // dec:<seq>-<sha256[:8]>
  targetId: string;      // 作用对象（计算或候选）
  action: DecisionAction;
  payload: Record<string, unknown>;
  rationale: string;
  branch: string;
  createdSeq: number;
  supersedes?: string;
}

// ---------- 事件（机器可读判断依据） ----------
export interface Event {
  seq: number;
  kind: string;          // material.imported / computation.completed / decision.recorded / ...
  refs: string[];
  branch: string;
  summary: string;       // 机器可读取的结构化摘要（JSON 字符串亦可）
  detail: Record<string, unknown>;
}

export interface Branch { id: string; name: string; fromSeq: number; }

// ---------- 反例档案 ----------
export interface Counterexample {
  id: string;
  name: string;
  baselineDigest: string;   // 基线（原图+方向+曝光+标称值+边界+中心）摘要
  changedSource: string;    // 唯一被改动的直接来源
  spec: Record<string, unknown>;   // 可重放的变体规格
  judgments: Event[];       // 机器可读的判断事件（含采纳与未采纳）
}

// ---------- 状态快照 ----------
export interface StateSnapshot {
  seqHead: number;
  asOfSeq: number;
  materials: Material[];
  params: ParamSet[];
  computations: Computation[];
  decisions: Decision[];
  events: Event[];
  branches: Branch[];
  counterexamples: Counterexample[];
  diagnostics: Diagnostic[];
}
