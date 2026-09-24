import { createHash } from 'node:crypto';

/** Canonical JSON with sorted keys: equivalent inputs get stable order and stable digests. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function sha256Hex(s: string | Buffer): string {
  return createHash('sha256').update(s).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** Deterministic stable identity: same content -> same id, idempotent export/import. */
export function stableId(prefix: string, ...parts: unknown[]): string {
  const h = sha256Hex(parts.map((p) => canonicalJson(p)).join('|'));
  return `${prefix}_${h.slice(0, 24)}`;
}
