import { createHash } from 'node:crypto';

export function digestOf(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex').slice(0, 24);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

let counter = 0;
export function stableId(prefix: string, seq: number): string {
  return `${prefix}_${String(seq).padStart(4, '0')}`;
}
export function uniqueSuffix(): string {
  counter += 1;
  return `${Date.now().toString(36)}_${counter}`;
}
