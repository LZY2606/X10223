import { createHash } from 'node:crypto';

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function shortHash(hex: string): string {
  return hex.slice(0, 16);
}

// 确定性 canonical JSON：键排序，无键空隙差异
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function contentId(prefix: string, payload: unknown): string {
  return `${prefix}_${shortHash(sha256Hex(canonicalJSON(payload)))}`;
}

export function digestOf(payload: unknown): string {
  return shortHash(sha256Hex(canonicalJSON(payload)));
}
