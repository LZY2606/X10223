import { createHash } from 'node:crypto';

// 等价输入得到稳定顺序：规范化 JSON（对象键排序、数组保序）
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function digestOf(value: unknown): string {
  return 'sha256:' + sha256Hex(canonicalize(value));
}
