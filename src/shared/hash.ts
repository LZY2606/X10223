import { createHash } from 'node:crypto';

/** 稳定 JSON（键排序），保证等价输入得到稳定身份与顺序 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.keys(value as Record<string, unknown>)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify((value as Record<string, unknown>)[k])}`);
  return `{${entries.join(',')}}`;
}

export function contentHash(prefix: string, value: unknown): string {
  return `${prefix}_${createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 16)}`;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function clamp(n: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, n));
}

export function round4(n: number): number {
  return Math.round(n * 1e4) / 1e4;
}
