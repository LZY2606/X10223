import { createHash } from 'node:crypto';

/** Canonical JSON: sorted keys, no whitespace — identical logical input => identical bytes. */
export function canonicalJSON(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalJSON).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJSON(obj[k])}`).join(',')}}`;
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function shortHash(input: string): string {
  return sha256Hex(input).slice(0, 16);
}

/** Stable identity for immutable material: same content => same id. */
export function materialId(kind: string, content: unknown): string {
  return `mat_${kind}_${shortHash(canonicalJSON({ kind, content }))}`;
}

/** Stable identity for a parameter/rule version. */
export function paramsHash(version: string, params: unknown): string {
  return `par_${shortHash(canonicalJSON({ version, params }))}`;
}

/**
 * Stable identity for a *display value* (an inference on a specific band under a
 * specific calibration segment). Survives export/delete/re-import and does not
 * depend on row ids, clocks, or insertion order.
 */
export function valueId(scope: string, parts: unknown[]): string {
  return `val_${shortHash(canonicalJSON({ scope, parts }))}`;
}

/** Monotonic per-branch ordering key that also reflects the parent lineage. */
export function eventOrderKey(branch: string, seq: number): string {
  return `${branch}#${String(seq).padStart(8, '0')}`
}
