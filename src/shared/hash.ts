import { createHash } from 'node:crypto';

/** 规范 JSON：键排序，无空白，保证等价输入得到等价摘要。 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(',')}}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

/** 内容寻址 id：前缀 + 12 位摘要。 */
export function contentId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256Hex(canonicalJson(value)).slice(0, 12)}`;
}
