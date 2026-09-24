import type { Basis, Diagnostic, Quantity, Unit } from './types';

const UNIT_ALIASES: Record<string, Unit> = {
  px: 'px', pixel: 'px', pixels: 'px',
  bp: 'bp', basepair: 'bp', basepairs: 'bp',
  log10bp: 'log10bp',
  ms: 'ms', millisecond: 'ms', milliseconds: 'ms',
  deg: 'deg', degree: 'deg', degrees: 'deg',
  rf: 'rf',
  intensity: 'intensity', gray: 'intensity',
};

// 导入时保留原始表示；只有派生层调用 normalize 做规范化。
export function rawQuantity(raw: string, basis: Basis): Quantity {
  return { raw, value: null, unit: null, basis };
}

export function normalize(q: Quantity, path: string): Quantity {
  if (q.value !== null && q.unit !== null) return q;
  const m = q.raw.trim().match(/^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/);
  if (!m) {
    const diagnostic: Diagnostic = {
      code: 'VALUE_UNPARSEABLE',
      message: `无法解析量值 "${q.raw}"，原值保留在原位置`,
      path,
      severity: 'error',
    };
    return { ...q, value: null, unit: null, diagnostic };
  }
  const unitRaw = m[2] ?? '';
  const unit = UNIT_ALIASES[unitRaw.toLowerCase()];
  if (!unit) {
    const diagnostic: Diagnostic = {
      code: 'UNIT_UNKNOWN',
      message: `未知单位 "${unitRaw || '(缺失)'}"，原值保留在原位置`,
      path,
      severity: 'error',
    };
    return { ...q, value: Number(m[1]), unit: null, diagnostic };
  }
  return { ...q, value: Number(m[1]), unit };
}

export function quantity(value: number, unit: Unit, basis: Basis): Quantity {
  return { raw: `${value} ${unit}`, value, unit, basis };
}

// 稳定排序比较器：等价输入 -> 稳定顺序
export function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
