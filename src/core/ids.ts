import { createHash } from 'node:crypto';

export function sha256Hex(data: Uint8Array | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function contentId(kind: string, payload: unknown): string {
  const h = createHash('sha256').update(kind).update('\0').update(canonicalJson(payload)).digest();
  const fnv = fnv1a64(h);
  return `${kind}_${fnv.toString(16).padStart(16, '0')}`;
}

export function shortHash(hex: string, len = 12): string {
  return hex.slice(0, len);
}

function fnv1a64(bytes: Uint8Array): bigint {
  let h = 0xcbf29ce484222325n;
  for (const b of bytes) {
    h ^= BigInt(b);
    h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
  }
  return h;
}
