import { createHash } from 'node:crypto';

/** 稳定内容摘要：等价输入 → 稳定身份（Node 与构建后的 Vite SSR 均可直接调用） */
export function sha256(input: string | Uint8Array): string {
  return createHash('sha256').update(input).digest('hex');
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(record[k])}`).join(',')}}`;
}

/** 内容寻址 id：同输入必得同 id；不同 kind 不撞车 */
export function contentId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256(canonicalJson(value)).slice(0, 16)}`;
}

export function digestOf(value: unknown): string {
  return sha256(canonicalJson(value));
}

/** 确定性时间戳（重放用）：单调、可重复，不依赖墙钟 */
export function replayClock(seq: number, baseIso = '2026-09-23T00:00:00.000Z'): string {
  const base = Date.parse(baseIso);
  return new Date(base + seq * 1000).toISOString();
}
