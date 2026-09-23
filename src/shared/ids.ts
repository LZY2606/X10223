import { createHash } from 'node:crypto';

/** Canonical JSON: object keys sorted recursively so equivalent values hash equally. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(canonicalize(value));
}

function canonicalize(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const v = (value as Record<string, unknown>)[key];
      if (v !== undefined) out[key] = canonicalize(v);
    }
    return out;
  }
  return value;
}

export function sha256Hex(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** Content-addressed identity: same content -> same id, independent of insert order. */
export function contentId(prefix: string, content: unknown): string {
  return `${prefix}_${sha256Hex(canonicalJson(content)).slice(0, 24)}`;
}

export function chainEventId(prevHash: string, seq: number, type: string, payload: unknown): string {
  return `evt_${sha256Hex(canonicalJson({ prevHash, seq, type, payload })).slice(0, 24)}`;
}
