// 所有领域量都携带单位或坐标基准。原始表示在导入层保留，派生层才做规范化。

export type Unit =
  | 'bp'
  | 'pixel'
  | 'gray8'
  | 'degree'
  | 'radian'
  | 'millisecond'
  | 'fraction';

/**
 * 带单位的量。raw 保留导入时的原始表示（字符串或数字），value 是规范化后的数值。
 * 无法转换时 value 为 null，并在诊断里给出原因；绝不用空值伪装成功。
 */
export interface Qty {
  value: number | null;
  unit: Unit;
  raw: string | number;
  system?: string; // 例如 "si:bp"、"image:pixel"
}

export const UNIT_CONVERSIONS: Record<Unit, string> = {
  bp: '核酸片段长度（碱基对）',
  pixel: '原始图像像素坐标',
  gray8: '8 位灰度强度 0..255',
  degree: '角度（度）',
  radian: '角度（弧度）',
  millisecond: '时间（毫秒）',
  fraction: '无量纲比例 0..1'
};

export function makeQty(raw: string | number, unit: Unit, system?: string): Qty {
  const numeric = typeof raw === 'number' ? raw : Number(raw);
  const value = Number.isFinite(numeric) ? numeric : null;
  return { value, unit, raw, system };
}

/** 无法转换时：value 必须为 null 并附诊断，而不是静默给默认值。 */
export function unconvertible(raw: string | number, unit: Unit, reason: string): { qty: Qty; reason: string } {
  return { qty: { value: null, unit, raw }, reason };
}
