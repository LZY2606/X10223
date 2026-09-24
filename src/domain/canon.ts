import { createHash } from 'node:crypto';

/** Canonical JSON: sorted keys, no whitespace. Stable across runs for equal input. */
export function canonical(value: unknown): string {
  if (value === null || value === undefined) return 'null';
  const t = typeof value;
  if (t === 'number' || t === 'boolean' || t === 'string') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + (value as unknown[]).map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256(canonical(value));
}
