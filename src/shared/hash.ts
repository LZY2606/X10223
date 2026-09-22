import { createHash, randomBytes } from 'node:crypto';

export function canonical(value: unknown): string {
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

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex');
}

export function digest(value: unknown): string {
  return sha256Hex(value).slice(0, 16);
}

const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';

export function stableId(prefix: string, seed: unknown): string {
  const hash = createHash('sha256').update(canonical(seed)).digest();
  let bits = 0n;
  for (const byte of hash) bits = (bits << 8n) | BigInt(byte);
  let encoded = '';
  for (let i = 0; i < 13; i++) {
    encoded = ALPHABET[Number(bits % 32n)] + encoded;
    bits /= 32n;
  }
  return `${prefix}_${encoded}`;
}

export function randomId(prefix: string): string {
  const bytes = randomBytes(8);
  let bits = 0n;
  for (const byte of bytes) bits = (bits << 8n) | BigInt(byte);
  let encoded = '';
  for (let i = 0; i < 13; i++) {
    encoded = ALPHABET[Number(bits % 32n)] + encoded;
    bits /= 32n;
  }
  return `${prefix}_${encoded}`;
}

/** 等价输入得到稳定顺序：按稳定 key 排序，key 相同再按身份排序。 */
export function stableSort<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
