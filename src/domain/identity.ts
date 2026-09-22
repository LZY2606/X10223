import { createHash } from 'node:crypto';

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableStringify(child)}`).join(',')}}`;
}

export function sha256(value: unknown | Buffer): string {
  const hash = createHash('sha256');
  if (Buffer.isBuffer(value)) hash.update(value);
  else hash.update(stableStringify(value));
  return hash.digest('hex');
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256(value).slice(0, 16)}`;
}

export function stableSortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((left, right) => left.id.localeCompare(right.id));
}
