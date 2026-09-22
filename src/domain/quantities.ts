import type { Diagnostic, Quantity, RawValue, Unit } from './types.js';

export function q(value: number, unit: Unit, basis: string): Quantity {
  if (!Number.isFinite(value)) throw new Error(`非有限数值不能构成 Quantity: ${value}`);
  return { value, unit, basis };
}

/** 可转换的分子量单位表（派生层规范化，原始表示不丢弃）。 */
const MW_TO_DA: Record<string, number> = {
  Da: 1,
  kDa: 1000,
  bp: 650, // 核酸常用近似换算基准：1 bp ≈ 650 Da（仅用于归一化显示）
};

export interface ParseResult {
  ok: boolean;
  value?: Quantity;
  diagnostic?: Diagnostic;
}

/** 解析原始表示；无法转换的值留在原位置并附诊断，不丢弃、不默认。 */
export function parseMwRaw(raw: RawValue, objectId: string): ParseResult {
  const text = raw.text.trim();
  const m = /^([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([a-zA-Zμµu%\/\d.\-]*)$/.exec(text);
  if (!m) {
    return {
      ok: false,
      diagnostic: {
        code: 'UNCONVERTIBLE_UNIT',
        severity: 'error',
        message: `无法解析分子量原文 "${text}"`,
        at: { objectId },
      },
    };
  }
  const value = Number(m[1]);
  const unit = (m[2] || raw.declaredUnit || '').trim();
  if (!Number.isFinite(value) || value <= 0) {
    return {
      ok: false,
      diagnostic: {
        code: 'UNCONVERTIBLE_UNIT',
        severity: 'error',
        message: `分子量必须为正有限数，收到 "${text}"`,
        at: { objectId },
      },
    };
  }
  if (unit === 'Da' || unit === 'kDa' || unit === 'bp') {
    return { ok: true, value: q(value, unit, `ladder 标称值原文 "${text}"`) };
  }
  return {
    ok: false,
    diagnostic: {
      code: 'UNCONVERTIBLE_UNIT',
      severity: 'error',
      message: `未知/不可转换单位 "${unit}"（原文保留未删除）`,
      at: { objectId },
    },
  };
}

export function toDa(quantity: Quantity): number {
  const f = MW_TO_DA[quantity.unit];
  if (f === undefined) throw new Error(`单位 ${quantity.unit} 不能转换为 Da`);
  return quantity.value * f;
}

export function formatQty(quantity: Quantity | undefined, digits = 2): string {
  if (!quantity) return '∅';
  return `${roundTo(quantity.value, digits)} ${quantity.unit}`;
}

function roundTo(v: number, d: number): number {
  const p = 10 ** d;
  return Math.round(v * p) / p;
}

export function log10MwDa(quantity: Quantity): number {
  return Math.log10(toDa(quantity));
}
