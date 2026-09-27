/** 领域量：所有值都携带单位与坐标/时间基准；原始表示在导入层保留，派生层才规范化。 */
export type Unit = 'bp' | 'px' | 'log10bp' | 'ms' | 'count' | 'ratio';
export type Basis =
  | 'image-raw'        // 原始拍摄像素坐标（未做旋转/方向归一化）
  | 'image-normalized' // 归一化迁移坐标（加样孔在上，y 向下为迁移方向）
  | 'lane-local'       // 泳道局部坐标（已扣除泳道弯曲偏移）
  | 'physical';        // 物理量（时间、浓度等）

export interface Quantity<U extends Unit = Unit> {
  value: number;
  unit: U;
  basis: Basis;
}

export function qty<U extends Unit>(value: number, unit: U, basis: Basis): Quantity<U> {
  return { value, unit, basis };
}

/** 导入时保留原始表示；无法转换的值留在原位置并附诊断，不为画图丢值。 */
export interface RawQuantity {
  raw: string;             // 原始字符串表示，如 "117.4px"
  parsed?: Quantity;       // 派生层规范化结果
  diagnostic?: string;     // 无法转换时的诊断（位置由外层 path 给出）
}

export function parseRawQuantity(raw: string, basis: Basis): RawQuantity {
  const m = /^(-?\d+(?:\.\d+)?)\s*(bp|px|ms|log10bp|count|ratio)$/.exec(raw.trim());
  if (!m) return { raw, diagnostic: `UNCONVERTIBLE_VALUE: 无法解析量值 "${raw}"` };
  return { raw, parsed: qty(parseFloat(m[1]), m[2] as Unit, basis) };
}
