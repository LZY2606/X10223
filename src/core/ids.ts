import { createHash } from 'node:crypto';

export function sha256(data: Uint8Array | string): string {
  return createHash('sha256').update(data as any).digest('hex');
}

export function hashJson(value: unknown): string {
  return sha256(canonicalJson(value));
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + canonicalJson(obj[k])).join(',') + '}';
}

let counter = 0;
export function stableId(prefix: string, content: unknown): string {
  return `${prefix}_${sha256(canonicalJson(content)).slice(0, 16)}`;
}

export function sequentialId(prefix: string, seq: number): string {
  counter += 1;
  return `${prefix}_${String(seq).padStart(5, '0')}`;
}

export function resetSequence(): void { counter = 0; }
