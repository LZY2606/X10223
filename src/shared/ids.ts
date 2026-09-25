import { createHash } from 'node:crypto';

export function sha256Hex(bytes: Uint8Array | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

export function shortHash(input: string, len = 16): string {
  return createHash('sha256').update(input).digest('hex').slice(0, len);
}

const ALPHABET = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';

export function base62FromHex(hex: string): string {
  let n = BigInt('0x' + hex);
  let out = '';
  while (n > 0n) {
    out = ALPHABET[Number(n % 62n)] + out;
    n /= 62n;
  }
  return out || '0';
}

let COUNTER = 0;

export function stableId(prefix: string, material: string): string {
  return `${prefix}_${shortHash(material, 18)}`;
}

export function contentId(prefix: string, canonical: string): string {
  return stableId(prefix, canonical);
}

export function nonce(): string {
  COUNTER = (COUNTER + 1) % 1_000_000;
  return `${Date.now().toString(36)}${COUNTER.toString(36).padStart(3, '0')}${Math.random().toString(36).slice(2, 8)}`;
}
