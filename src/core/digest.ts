import { createHash } from 'node:crypto';

/**
 * 确定性规范化 JSON（键排序），等价输入得到稳定摘要与稳定顺序。
 */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(',')}}`;
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input as any).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJSON(value)).slice(0, 16);
}
