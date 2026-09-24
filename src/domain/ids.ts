import { createHash } from 'node:crypto';

/** Stable canonical JSON: object keys sorted recursively so equivalent
 *  inputs always produce the same digest and therefore stable identity/order. */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalize).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalize(obj[k])).join(',') + '}';
}

export function digest(value: unknown): string {
  const text = typeof value === 'string' ? value : canonicalize(value);
  return createHash('sha256').update(text).digest('hex');
}

export function materialId(kind: string, raw: unknown): string {
  return `mat_${kind}_${digest(raw).slice(0, 16)}`;
}

export function resultId(kind: string, inputDigest: string, paramsVersion: string, parents: string[]): string {
  return `res_${kind}_${digest({ kind, inputDigest, paramsVersion, parents: [...parents].sort() }).slice(0, 16)}`;
}

export function eventId(seq: number, type: string, payload: unknown): string {
  return `evt_${seq}_${digest({ seq, type, payload }).slice(0, 12)}`;
}
