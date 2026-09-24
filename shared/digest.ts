import { createHash } from 'node:crypto';

// 稳定字符串化：键排序、数字定精度，保证等价输入得到等价摘要
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) return `"${String(value)}"`;
    return JSON.stringify(Number(value.toFixed(6)));
  }
  if (typeof value === 'string') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'true' : 'false';
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256(canonical(value));
}

export function contentId(prefix: string, value: unknown, len = 16): string {
  return `${prefix}:${sha256(canonical(value)).slice(0, len)}`;
}
