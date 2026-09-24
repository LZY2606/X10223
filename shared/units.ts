import type { Diagnostic, Quantity, Unit } from './types';

const UNIT_ALIASES: Record<string, Unit> = {
  px: 'px',
  pixel: 'px',
  pixels: 'px',
  bp: 'bp',
  kbp: 'bp',
  ms: 'ms',
  millisecond: 'ms',
  s: 's',
  sec: 's',
  deg: 'deg',
  degree: 'deg',
};

const SCALE: Partial<Record<string, number>> = {
  kbp: 1000,
  s: 1000,
};

export interface ParsedQuantity {
  raw: string;
  quantity: Quantity | null;
  diagnostic: Diagnostic | null;
}

export function parseQuantity(raw: string, location: string, basis?: string): ParsedQuantity {
  const text = String(raw).trim();
  const m = /^(-?\d+(?:\.\d+)?)\s*([a-zA-Z]+)?$/.exec(text);
  if (!m) {
    return {
      raw,
      quantity: null,
      diagnostic: {
        code: 'UNIT_UNPARSEABLE',
        message: `无法解析的量值 "${text}"，保留原始表示，不做规范化`,
        location,
        severity: 'error',
      },
    };
  }
  const value = Number(m[1]);
  const unitRaw = (m[2] ?? '').toLowerCase();
  if (!unitRaw) {
    return {
      raw,
      quantity: null,
      diagnostic: {
        code: 'UNIT_MISSING',
        message: `量值 "${text}" 缺少单位，保留原始表示`,
        location,
        severity: 'error',
      },
    };
  }
  const unit = UNIT_ALIASES[unitRaw];
  if (!unit) {
    return {
      raw,
      quantity: null,
      diagnostic: {
        code: 'UNIT_UNCONVERTIBLE',
        message: `单位 "${unitRaw}" 无法转换，值留在原位置`,
        location,
        severity: 'error',
      },
    };
  }
  const scale = SCALE[unitRaw] ?? 1;
  return { raw, quantity: { value: value * scale, unit, basis }, diagnostic: null };
}

export function requireQuantity(raw: string | undefined, location: string, basis?: string): ParsedQuantity {
  if (raw === undefined || raw === null || String(raw).trim() === '') {
    return {
      raw: raw ?? '',
      quantity: null,
      diagnostic: {
        code: 'MISSING_INPUT',
        message: `输入缺失：${location}，不得以空值或默认值伪装成功`,
        location,
        severity: 'error',
      },
    };
  }
  return parseQuantity(raw, location, basis);
}
