import { createHash } from 'node:crypto';

/** Canonical JSON: sorted keys, no undefined. Equivalent inputs -> identical bytes -> stable identity/order. */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value) ?? 'null';
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonical(value), 'utf8').digest('hex');
}

export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${digest(value).slice(0, 20)}`;
}
