// 领域类型：胶道标尺工作台
// 分层原则：materials 为不可变材料（原图/拍摄方向/曝光/ladder 标称值/lane 边界/条带中心），
// 全部携带像素级来源；derived 为可重算派生层；decisions 为可修改决定（事件）。

export type Unit = 'px' | 'bp' | 'kDa' | 'ms' | 'ratio' | 'log10bp';

/** 坐标基准：image 为原始像素坐标（左上原点），migration 为迁移方向校正坐标 */
export type CoordBasis = 'image-top-left' | 'migration-corrected';

export interface Quantity {
  value: number;
  unit: Unit;
  basis: CoordBasis;
}

export interface PixelPoint {
  x: Quantity;
  y: Quantity;
}

/** 像素级来源：每个材料字段都能指回产生它的对象与像素位置 */
export interface Provenance {
  sourceId: string;        // 直接来源对象 id（如 img_base / mat_ladder_nominal）
  pixel?: { x: number; y: number };
  note?: string;
}

export interface Diagnostic {
  severity: 'info' | 'warning' | 'error';
  code: string;            // 机器可读，如 LADDER_NON_MONOTONIC / BAND_SATURATED
  message: string;
  position?: { objectKind: string; objectId: string; pixel?: { x: number; y: number } };
}

/** 三种失败必须区分：预算耗尽 / 格式损坏 / 语义无解 */
export type ComputeResult<T> =
  | { status: 'ok'; value: T; diagnostics: Diagnostic[] }
  | { status: 'budget-exhausted'; diagnostics: Diagnostic[] }
  | { status: 'format-corrupt'; diagnostics: Diagnostic[] }
  | { status: 'semantic-unsolvable'; diagnostics: Diagnostic[] };

// ---------- 不可变材料 ----------

export interface ImageMaterial {
  id: string;
  kind: 'image';
  file: string;                 // 相对案例包路径
  width: number;                // px
  height: number;               // px
  orientation: 'wells-top' | 'wells-left' | 'wells-bottom' | 'wells-right';
  rotationDeg: 0 | 90 | 180 | 270;
  exposure: { timeMs: number; gain: number };
  provenance: Provenance;
}

export interface LadderMaterial {
  id: string;
  kind: 'ladder';
  name: string;
  /** 标称分子量，导入时保留原始表示（字符串原样），派生层才规范化 */
  nominalRaw: string[];
  unit: 'bp' | 'kDa';
  provenance: Provenance;
}

export interface LaneMaterial {
  id: string;
  kind: 'lane';
  role: 'ladder' | 'sample';
  label: string;
  /** 泳道边界：顶/底中心点 + 半宽，像素级 */
  top: { x: number; y: number };
  bottom: { x: number; y: number };
  halfWidthPx: number;
  /** 弯曲系数：centerX(y) = bendQuadratic*y^2 + bendLinear*y + top.x（微笑弯曲非零） */
  bendQuadratic: number;
  bendLinear: number;
  provenance: Provenance;
}

export interface BandMaterial {
  id: string;
  kind: 'band';
  laneId: string;
  /** 条带中心，像素级来源 */
  center: { x: number; y: number };
  /** ladder 条带对应标称序列下标；样本条带为 null */
  ladderIndex: number | null;
  /** 饱和比例 0..1；>0 表示像素截断，中心不可唯一定位 */
  saturation: number;
  /** 拖尾长度 px */
  smearPx: number;
  /** 重叠组 id：同组条带不可唯一分离 */
  overlapGroup: string | null;
  provenance: Provenance;
}

export type Material = ImageMaterial | LadderMaterial | LaneMaterial | BandMaterial;

// ---------- 派生层 ----------

/** 局部标尺：一段 ladder 相邻点之间的 log10 线性插值，必须带有效区域 */
export interface LocalScale {
  id: string;
  laneRegion: { xMin: number; xMax: number };   // 微笑校正覆盖的横向有效区
  yTop: number;                                  // 校正坐标下有效 y 区间
  yBottom: number;
  upperBp: number;
  lowerBp: number;
  degraded: boolean;              // ladder 缺带导致的跨段
  invalidReason: string | null;   // 修订后局部失效等原因
}

export type BandEstimate =
  | { form: 'point'; mwBp: number; log10Mw: number }
  | { form: 'interval'; mwBpLo: number; mwBpHi: number; reason: 'saturated' | 'smear' }
  | { form: 'candidate-set'; candidates: number[]; reason: 'overlap' }
  | { form: 'unresolved'; reason: string };

export interface BandDerived {
  id: string;
  bandId: string;
  correctedY: number;             // 微笑校正后的迁移坐标
  scaleId: string | null;         // 使用的局部标尺
  estimate: BandEstimate;
  residualPx: number | null;      // ladder 点的拟合残差（样本条带为 null）
  status: 'auto-candidate' | 'accepted' | 'rejected' | 'revised';
}

// ---------- 事件 ----------

export type EventKind =
  | 'import'        // 导入案例包/材料
  | 'compute'       // 一次派生计算（记录输入摘要+参数版本）
  | 'decision'      // 人工决定：accept/reject/adjust
  | 'revision'      // 源数据修订（只影响局部依赖）
  | 'export'
  | 'import-project';

export interface AppEvent {
  id: string;
  seq: number;
  kind: EventKind;
  payload: Record<string, unknown>;
  inputDigest: string;      // 输入材料摘要
  paramVersion: string;     // 参数/规则版本
  parents: string[];        // 父级依赖（事件或材料 id）
  createdAt: string;        // ISO 时间基准
}

export interface Decision {
  targetId: string;         // BandDerived id
  action: 'accept' | 'reject' | 'adjust';
  adjustedMwBp?: number;
  rationale: string;
}
