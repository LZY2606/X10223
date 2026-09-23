import { createHash } from 'node:crypto';

export function stableHash(parts: unknown[]): string {
  return createHash('sha256').update(canonicalJson(parts)).digest('hex');
}

export function stableId(prefix: string, parts: unknown[]): string {
  return `${prefix}-${stableHash(parts).slice(0, 16)}`;
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(',')}}`;
}
