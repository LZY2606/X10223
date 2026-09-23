import { createHash } from 'node:crypto';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 稳定内容 id：对规范化后的 JSON 内容取 sha256，前 16 字符。等价输入 => 等价身份 */
export function stableId(prefix: string, parts: unknown[]): string {
  const canonical = parts.map((p) => canonicalize(p)).join('|');
  return `${prefix}_${sha256Hex(canonical).slice(0, 16)}`;
}

export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}
