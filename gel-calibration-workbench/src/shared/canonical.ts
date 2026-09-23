import { createHash } from 'node:crypto';

// 规范化：键排序、数字定精度，保证等价输入得到稳定顺序与稳定摘要。
export function canonicalize(value: unknown): unknown {
  if (value === null || value === undefined) return null;
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return String(value);
    return Math.round(value * 1e9) / 1e9;
  }
  if (Array.isArray(value)) return value.map(canonicalize);
  if (typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) out[key] = canonicalize(src[key]);
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function computationId(kind: string, digest: string): string {
  return `cmp-${kind.toLowerCase()}-${digest.slice(0, 16)}`;
}

let eventCounter = 0;
export function eventId(seq: number, slug: string): string {
  eventCounter += 1;
  return `evt-${String(seq).padStart(5, '0')}-${slug}`;
}
export function resetEventCounter(): void {
  eventCounter = 0;
}
