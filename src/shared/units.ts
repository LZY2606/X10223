import type { Diagnostic, Quantity } from './types';

/**
 * 单位与原始表示。
 * 导入时保留原始文本；只有派生层规范化。无法转换的值留在原位置并附诊断。
 */

const UNIT_ALIASES: Record<string, { canonical: string; scale: number }> = {
  bp: { canonical: 'bp', scale: 1 },
  kbp: { canonical: 'bp', scale: 1000 },
  kb: { canonical: 'bp', scale: 1000 },
  da: { canonical: 'Da', scale: 1 },
  kda: { canonical: 'kDa', scale: 1 },
  px: { canonical: 'px', scale: 1 },
  pixel: { canonical: 'px', scale: 1 },
  ms: { canonical: 'ms', scale: 1 },
  s: { canonical: 'ms', scale: 1000 },
  ev: { canonical: 'eV', scale: 1 },
};

export function parseQuantity(rawText: string, position?: Diagnostic['position']): Quantity {
  const raw = rawText.trim();
  const m = raw.match(/^([-+]?(?:\d+\.?\d*|\.\d+)(?:[eE][-+]?\d+)?)\s*([A-Za-z%°/μu.·]*)$/);
  if (!m) {
    return {
      rawText: raw,
      convertible: false,
      diagnostic: {
        code: 'UNCONVERTIBLE_UNIT',
        severity: 'error',
        message: `无法把原始表示 "${raw}" 解析为带单位的量，保留在原位置`,
        position: position ?? {},
      },
    };
  }
  const num = Number(m[1]);
  const unitText = m[2].toLowerCase();
  const alias = UNIT_ALIASES[unitText];
  if (!alias) {
    return {
      rawText: raw,
      value: num,
      unit: m[2] || undefined,
      convertible: false,
      diagnostic: {
        code: 'UNCONVERTIBLE_UNIT',
        severity: 'error',
        message: `未知单位 "${m[2] || '(空)'}"，不做猜测，值保留原始表示`,
        position: position ?? {},
      },
    };
  }
  return {
    rawText: raw,
    value: num * alias.scale,
    unit: alias.canonical,
    convertible: true,
  };
}

export function withValue(q: Quantity, value: number, unit: string): Quantity {
  return { ...q, value, unit, convertible: true, diagnostic: undefined };
}
