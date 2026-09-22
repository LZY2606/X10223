import { createHash } from 'node:crypto';

// Canonical JSON: object keys sorted recursively so equivalent inputs
// produce identical digests and stable ordering.
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256hex(canonicalJson(value));
}

// Content-addressed stable id: same content -> same id, across export/import.
export function stableId(prefix: string, content: unknown): string {
  return `${prefix}_${sha256hex(canonicalJson(content)).slice(0, 16)}`;
}
