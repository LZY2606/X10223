import type { Diagnostic, DomainValue, Unit } from './types.js';

/** 解析标称值原始表示；无法转换时保留原值并附诊断（绝不用默认值伪装成功）。 */
export function parseDomainValue(raw: string, unit: Unit, location?: Diagnostic['location']): DomainValue {
  const trimmed = raw.trim();
  if (trimmed === '') {
    return {
      value: null,
      unit,
      raw,
      diagnostic: {
        code: 'INCOMPLETE_INPUT',
        severity: 'error',
        message: '标称值为空，缺少原始表示',
        location
      }
    };
  }
  const normalized = trimmed.replace(/[, ]+/g, '').match(/^[+-]?(\d+(\.\d+)?)([kK])?(?:bp|kDa|px)?.*/);
  const match = trimmed.replace(/,/g, '').match(/^[+-]?(\d+(?:\.\d+)?)\s*(k|K)?/);
  if (!match || !normalized) {
    return {
      value: null,
      unit,
      raw,
      diagnostic: {
        code: 'UNCONVERTIBLE_VALUE',
        severity: 'error',
        message: `无法把 "${raw}" 转换为数值（${unit}），原值保留在原位置`,
        location
      }
    };
  }
  let value = parseFloat(match[1]!);
  if (match[2]) value *= unit === 'bp' ? 1000 : 1;
  return { value, unit, raw };
}

export function makePixelValue(v: number, frameId: string, axis: 'x' | 'y' | 's'): DomainValue {
  return {
    value: v,
    unit: 'pixel',
    raw: `${v.toFixed(2)} px`,
    ref: { frameId, frameKind: 'raw-image', axis, unit: 'pixel' }
  };
}

export function valueOrNull(v: DomainValue | null | undefined): number | null {
  return v && typeof v.value === 'number' ? v.value : null;
}

export function fmt(v: DomainValue | null | undefined): string {
  if (!v) return '∅';
  if (v.value === null) return `${v.raw}（不可转换）`;
  return `${v.value} ${v.unit}`;
}
