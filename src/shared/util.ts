import { createHash } from 'node:crypto';

/**
 * 规范化 JSON：键排序、无多余空白，保证同一内容在任何机器上得到同一字节序列，
 * 进而得到稳定身份（digest / id）。
 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (value === null || typeof value !== 'object') {
    if (typeof value === 'number' && !Number.isFinite(value)) {
      throw new TypeError('canonicalJson 不接受 NaN/Infinity');
    }
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortValue);
  }
  const record = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    const v = record[key];
    if (v !== undefined) {
      out[key] = sortValue(v);
    }
  }
  return out;
}

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data as any).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function shortHash(value: unknown, len = 12): string {
  return digestOf(value).slice(0, len);
}

export function nowIso(clock: () => Date = () => new Date()): string {
  return clock().toISOString();
}

/** 由字节生成稳定内容 id。 */
export function contentId(prefix: string, payload: unknown): string {
  return `${prefix}_${shortHash(payload)}`;
}

export function clamp(x: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, x));
}

export function roundTo(x: number, digits: number): number {
  const f = 10 ** digits;
  return Math.round((x + Number.EPSILON) * f) / f;
}
