import { createHash } from 'node:crypto';

/** 稳定序列化：键排序，保证等价输入得到稳定身份与顺序。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + stableStringify(v)).join(',') + '}';
}

export function sha256(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

let counter = 0;
/** 事件 id 内容寻址；材料 id 带可读前缀 + 内容哈希。 */
export function contentId(prefix: string, body: unknown): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${sha256(body).slice(0, 16)}`;
}
