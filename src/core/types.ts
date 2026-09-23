/** 领域类型：所有量携带单位或坐标基准；原始表示保留在材料层。 */

export type Unit = 'bp' | 'px' | 'ms' | 'dimensionless';

/** 图像像素坐标基准：原点左上，+x 向右，+y 向下（未旋转的原始图像帧）。 */
export interface PixelPoint {
  x: number;
  y: number;
  basis: 'image-pixel';
}

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** 诊断必须带位置：定位到材料 / 泳道 / 条带 / 像素。 */
  position: {
    materialId?: string;
    laneIndex?: number;
    bandId?: string;
    pixel?: { x: number; y: number };
  };
}

export type MaterialKind =
  | 'image' // 原图（像素级来源）
  | 'orientation' // 拍摄方向
  | 'exposure' // 曝光参数
  | 'ladder_nominal' // ladder 标称值
  | 'lane_boundary' // 泳道边界
  | 'band_center' // 条带中心
  | 'param_set'; // 可修订参数

export interface Material {
  id: string; // 内容寻址，稳定身份
  kind: MaterialKind;
  branchId: string;
  payload: Record<string, unknown>;
  createdSeq: number; // 由哪个事件引入
}

export type ComputationKind = 'lane_fit' | 'calibration' | 'mw_inference';

export type ComputationStatus = 'ok' | 'candidate' | 'interval' | 'failed';

export interface Computation {
  id: string;
  kind: ComputationKind;
  branchId: string;
  status: ComputationStatus;
  inputDigest: string; // 输入摘要
  paramVersion: string; // 参数版本（param_set 材料 id）
  parents: string[]; // 父级依赖（材料/计算 id）
  result: Record<string, unknown>;
  diagnostics: Diagnostic[];
  createdSeq: number;
  /** 修订后局部失效：被更新计算取代时记录取代者。 */
  supersededBy: string | null;
}

export type DecisionVerdict = 'accept' | 'reject' | 'adjust';

export interface Decision {
  id: string;
  branchId: string;
  targetId: string; // 计算或材料 id
  verdict: DecisionVerdict;
  rationale: string;
  payload?: Record<string, unknown>;
  createdSeq: number;
  supersededSeq: number | null; // 回到旧事件时按此恢复当时结论
}

export interface EventRecord {
  seq: number;
  id: string;
  branchId: string;
  type:
    | 'seed'
    | 'material_added'
    | 'param_revised'
    | 'source_mutated'
    | 'computed'
    | 'decision'
    | 'invalidated'
    | 'exported'
    | 'imported';
  summary: string;
  payload: Record<string, unknown>;
  parentSeqs: number[]; // 因果父级
  createdAt: string; // ISO 时间基准
}

export interface Branch {
  id: string;
  name: string;
  parentBranchId: string | null;
  forkSeq: number; // 从哪个事件分叉
  createdSeq: number;
}

/** 分子量推断结果：成功给值，候选/区间给范围，失败给原因——绝不用空值伪装。 */
export interface MwEstimate {
  status: ComputationStatus;
  valueBp?: number;
  intervalBp?: [number, number];
  unit: 'bp';
  provenance?: {
    segmentId: string;
    ladderPointIds: [string, string];
    interpolation: 'log-linear';
  };
  validity?: { yMinPx: number; yMaxPx: number; basis: 'image-pixel' };
  failureReason?: string;
  candidates?: Array<{ valueBp: number; source: string }>;
}
