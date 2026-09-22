import { createHash } from 'node:crypto';

export function sha256Hex(buf: Buffer | Uint8Array): string {
  return createHash('sha256').update(buf as Buffer).digest('hex');
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  return '{' + Object.keys(obj).sort().map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export function contentId(prefix: string, parts: unknown[]): string {
  return prefix + '_' + sha256Hex(Buffer.from(stableStringify(parts), 'utf8')).slice(0, 24);
}

export function digestOf(parts: unknown[]): string {
  return sha256Hex(Buffer.from(stableStringify(parts), 'utf8'));
}
