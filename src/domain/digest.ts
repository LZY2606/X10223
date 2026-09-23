import { createHash } from 'node:crypto';

export function sha256(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

// 规范化 JSON：键排序，保证等价输入得到稳定字节序列。
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortKeys);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortKeys((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function digestOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function shortId(prefix: string, digest: string): string {
  return `${prefix}_${digest.slice(0, 16)}`;
}
