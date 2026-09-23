import type { Diagnostic, QuantitativeValue, Unit } from './types.js';

/**
 * 解析带单位的原始表示。原始字符串永远保留；
 * 无法转换时 value=null 并附诊断，绝不用默认值伪装成功。
 */
export function parseQuantity(
  rawValue: string,
  path: string,
  allowedUnits?: Unit[],
): QuantitativeValue {
  const raw = String(rawValue).trim();
  const m = raw.match(/^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-z%]+)?$/);
  if (!m) {
    const diag: Diagnostic = {
      code: 'UNPARSEABLE_VALUE',
      message: `无法解析数值：${raw}`,
      path,
    };
    return { value: null, unit: null, rawValue: raw, diagnostic: diag };
  }
  const value = Number(m[1]);
  const rawUnit = m[2] ?? '';
  const unit = normalizeUnit(rawUnit);
  if (!unit) {
    const diag: Diagnostic = {
      code: 'UNCONVERTIBLE_UNIT',
      message: `未知单位：${rawUnit}`,
      path,
    };
    return { value: null, unit: null, rawValue: raw, rawUnit, diagnostic: diag };
  }
  if (allowedUnits && !allowedUnits.includes(unit)) {
    const diag: Diagnostic = {
      code: 'UNCONVERTIBLE_UNIT',
      message: `单位 ${unit} 不在允许集合 ${allowedUnits.join('|')} 内`,
      path,
    };
    return { value, unit, rawValue: raw, rawUnit, diagnostic: diag };
  }
  return { value, unit, rawValue: raw, rawUnit };
}

function normalizeUnit(raw: string): Unit | null {
  switch (raw.toLowerCase()) {
    case 'bp':
    case 'bps':
      return 'bp';
    case 'kda':
      return 'kDa';
    case 'ms':
      return 'ms';
    case 's':
      return 'ms'; // s 在调用方按需换算，这里保留映射
    case 'px':
    case 'pixel':
    case 'pixels':
      return 'pixel';
    default:
      return null;
  }
}

/** 曝光/时长统一规范化为毫秒，原始值仍保留。 */
export function parseDurationMs(rawValue: string, path: string): QuantitativeValue {
  const q = parseQuantity(rawValue, path);
  if (q.value !== null && q.unit === 'ms' && q.rawUnit?.toLowerCase() === 's') {
    return { ...q, value: q.value * 1000, unit: 'ms' };
  }
  return q;
}

export function parseOrientation(raw: string, path: string): { deg: number | null; diagnostic?: Diagnostic } {
  const norm = raw.trim().toLowerCase().replace(/[°\s]/g, '');
  const table: Record<string, number> = {
    '0': 0,
    '90': 90,
    '90cw': 90,
    'cw90': 90,
    '180': 180,
    '270': 270,
    '270cw': 270,
    '90ccw': 270,
  };
  if (norm in table) return { deg: table[norm] };
  return {
    deg: null,
    diagnostic: { code: 'UNPARSEABLE_VALUE', message: `无法解析拍摄方向：${raw}`, path },
  };
}
