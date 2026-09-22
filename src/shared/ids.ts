import { createHash } from 'node:crypto';

/**
 * 稳定身份与规范化序列化。
 * 所有派生身份都来自“直接输入内容 + 参数版本 + 父级依赖”，
 * 因此等价输入必然产生相同身份与顺序。
 */
export function sha256Hex(payload: Uint8Array | string): string {
  const h = createHash('sha256');
  h.update(payload);
  return h.digest('hex');
}

const KEY_ORDER = ['unit', 'symbol', 'scale', 'basis', 'x', 'y'];

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const keys = Object.keys(src).sort((a, b) => (a === b ? 0 : a < b ? -1 : 1));
    const out: Record<string, unknown> = {};
    for (const k of keys) {
      if (src[k] !== undefined) out[k] = sortValue(src[k]);
    }
    void KEY_ORDER;
    return out;
  }
  return value;
}

export function stableId(prefix: string, ...parts: unknown[]): string {
  const digest = sha256Hex(canonicalJson(parts.length === 1 ? parts[0] : parts));
  return `${prefix}_${digest.slice(0, 16)}`;
}

/** 稳定排序键：相同输入 → 相同顺序。 */
export function stableCompare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function numericCompare(a: number, b: number): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
