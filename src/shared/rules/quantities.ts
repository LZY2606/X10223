import type { Diagnostic, Quantity, Unit } from '../types.ts';

// 原始表示保留在 raw；无法转换留在原位并附位置诊断，绝不用默认值伪装。
export function parseQuantity(raw: string, expectedUnit: Unit, path: string): Quantity {
  const text = raw.trim();
  const m = text.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(k?bp|bp|kb|kDa|g)?$/i);
  if (!m) {
    return {
      raw,
      value: null,
      unit: expectedUnit,
      convertible: false,
      diagnostic: {
        code: 'UNCONVERTIBLE_VALUE',
        severity: 'error',
        message: `无法将 ${JSON.stringify(raw)} 转换为 ${expectedUnit}，原始值保留在 ${path}`,
        path
      } satisfies Diagnostic
    };
  }
  let value = Number(m1(m));
  const unit = (m[2] || expectedUnit).toLowerCase();
  if (expectedUnit === 'bp' && (unit === 'kbp' || unit === 'kb')) value *= 1000;
  if (expectedUnit === 'bp' && unit === 'bp') {
    /* bp */
  }
  if (value <= 0 || !Number.isFinite(value)) {
    return {
      raw,
      value: null,
      unit: expectedUnit,
      convertible: false,
      diagnostic: {
        code: 'UNCONVERTIBLE_VALUE',
        severity: 'error',
        message: `${JSON.stringify(raw)} 不是有效的 ${expectedUnit} 正值`,
        path
      } satisfies Diagnostic
    };
  }
  return { raw, value, unit: expectedUnit, convertible: true };
}
function m1(match: RegExpMatchArray): string {
  return match[1];
}

export function assertMonotonic(values: Array<number | null>): boolean {
  const nums = values.filter((v): v is number => v !== null);
  for (let i = 1; i < nums.length; i++) if (nums[i] >= nums[i - 1]) return false; // bp 随 t 严格递减
  return true;
}
