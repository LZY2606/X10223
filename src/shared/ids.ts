import { createHash } from 'node:crypto';

export function sha256Hex(input: Buffer | string): string {
  return createHash('sha256').update(input).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function stableJson(value: unknown): string {
  return canonicalJson(value);
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const child = (value as Record<string, unknown>)[key];
      if (child === undefined) continue;
      out[key] = sortDeep(child);
    }
    return out;
  }
  return value ?? null;
}

export function deterministicId(prefix: string, ...parts: unknown[]): string {
  return `${prefix}_${digestOf(parts).slice(0, 16)}`;
}
