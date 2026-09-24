/**
 * Deterministic identity.
 *
 * Equivalent inputs produce identical ids and identical sort order regardless
 * of insertion timing. Ids are content-addressed for derived results; events
 * get stable ids from (project, branch, seq) and materials from their
 * canonical content hash with a type prefix.
 */
import { createHash } from 'node:crypto';

export function sha256Hex(payload: Uint8Array | string): string {
  return createHash('sha256').update(payload).digest('hex');
}

/** Stable JSON: sorted object keys, no whitespace, bigint-safe numbers. */
export function canonicalJSON(value: unknown): string {
  const seen = new WeakSet<object>();
  const encode = (v: unknown): string => {
    if (v === null) return 'null';
    const t = typeof v;
    if (t === 'string') return JSON.stringify(v);
    if (t === 'number' || t === 'boolean') return JSON.stringify(v);
    if (t === 'bigint') return JSON.stringify(v.toString());
    if (v instanceof Uint8Array) return JSON.stringify(sha256Hex(v));
    if (Array.isArray(v)) return '[' + v.map(encode).join(',') + ']';
    if (t === 'object') {
      const obj = v as Record<string, unknown>;
      if (seen.has(obj)) throw new Error('cyclic canonicalisation');
      seen.add(obj);
      const keys = Object.keys(obj)
        .filter((k) => obj[k] !== undefined)
        .sort();
      const parts = keys.map((k) => JSON.stringify(k) + ':' + encode(obj[k]));
      seen.delete(obj);
      return '{' + parts.join(',') + '}';
    }
    throw new Error('unsupported canonical value: ' + t);
  };
  return encode(value);
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJSON(value)).slice(0, 16);
}

let counter = 0;

export function derivedId(kind: string, inputDigest: string, parentKey: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${kind}_${digestOf([kind, inputDigest, parentKey])}`;
}

export function materialId(kind: string, canonical: unknown): string {
  return `mat_${kind}_${digestOf(canonical)}`;
}

export function stableEventId(projectId: string, branchId: string, seq: number): string {
  return `evt_${digestOf([projectId, branchId, seq])}`;
}

export function uid(prefix: string): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}`;
}

/** Stable ordering for values whose identity must survive export/import. */
export function stableSort<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
