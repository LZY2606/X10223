import type { Diagnostic, Quantity, Unit } from './types.ts';

/**
 * 解析带单位的分子量，保留原始表示。
 * 无法转换时 value=null 并附带位置的诊断 —— 绝不用空值/默认值伪装成功。
 */
export function parseQuantity(rawIn: unknown, allowedUnits: Unit[] = ['bp', 'kDa', 'nt']): Quantity {
  const raw = typeof rawIn === 'string' ? rawIn.trim() : String(rawIn ?? '');
  const m = raw.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(bp|kDa|nt)?$/i);
  if (!m) {
    const d: Diagnostic = {
      code: 'QTY_UNPARSEABLE',
      message: `无法把 "${raw}" 转换为分子量（期望如 "1500 bp" 或 "50 kDa"）`,
      severity: 'error',
    };
    return { value: null, unit: allowedUnits[0], raw, conversion: d };
  }
  const num = Number(m[1]);
  const unit = (m[2]?.toLowerCase() as Unit) ?? allowedUnits[0];
  if (!allowedUnits.includes(unit)) {
    return {
      value: null,
      unit,
      raw,
      conversion: {
        code: 'QTY_BAD_UNIT',
        message: `单位 ${unit} 不在允许集合 ${allowedUnits.join('|')} 内`,
        severity: 'error',
      },
    };
  }
  if (!Number.isFinite(num)) {
    return {
      value: null,
      unit,
      raw,
      conversion: { code: 'QTY_NONFINITE', message: `"${raw}" 不是有限数值`, severity: 'error' },
    };
  }
  return { value: num, unit, raw };
}

export function isMonotonicDecreasing(values: number[]): boolean {
  for (let i = 1; i < values.length; i++) {
    if (values[i] >= values[i - 1]) return false;
  }
  return true;
}
