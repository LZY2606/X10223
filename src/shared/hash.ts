// 规范化 JSON + 稳定哈希。浏览器与 Node 均可运行（不依赖 node:crypto 时用调用方注入）。
import { createHash } from 'node:crypto';

export function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(data: Uint8Array | string): string {
  const buf = typeof data === 'string' ? Buffer.from(data, 'utf8') : Buffer.from(data);
  return createHash('sha256').update(buf).digest('hex');
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}
