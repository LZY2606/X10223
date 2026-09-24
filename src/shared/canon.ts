import { createHash } from 'node:crypto';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** Canonical JSON: key order normalized so equivalent inputs hash identically. */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** Stable identity derived purely from content: same input -> same id, forever. */
export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${digest(value).slice(0, 16)}`;
}
