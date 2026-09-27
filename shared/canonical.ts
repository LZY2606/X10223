import { createHash } from 'node:crypto';

/** Deterministic JSON stringify: object keys sorted recursively. */
export function stableStringify(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const src = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(src).sort()) {
      const v = src[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function sha256hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256hex(stableStringify(value));
}

/** Stable, content-addressed identity: kind + first 24 hex chars of digest. */
export function contentId(kind: string, payload: unknown): string {
  return `${kind}_${digestOf(payload).slice(0, 24)}`;
}
