import { createHash } from 'node:crypto';

/** 稳定字符串化（键排序），保证等价输入得到等价摘要与稳定顺序。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 内容寻址 id：等价输入得到稳定身份与稳定顺序。 */
export function contentId(prefix: string, payload: unknown): string {
  return `${prefix}_${sha256(canonical(payload)).slice(0, 16)}`;
}
