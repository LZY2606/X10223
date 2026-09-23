import { createHash } from 'node:crypto';

/** 内容寻址哈希。规范化 JSON（键排序）保证等价输入得到相同哈希与稳定顺序。 */
export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

export function sha256Bytes(bytes: Uint8Array | Buffer): string {
  return createHash('sha256').update(Buffer.from(bytes)).digest('hex');
}

/** 稳定的规范化序列化：对象键按码点排序，Float32Array 显式展开（仅用于缓存）。 */
export function canonicalJson(value: unknown, seen: WeakSet<object> = new WeakSet()): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Float32Array || value instanceof Uint8Array) {
    return JSON.stringify({ __typed: value.constructor.name, data: Array.from(value as Float32Array) });
  }
  if (seen.has(value as object)) throw new Error('canonicalJson: cycle');
  seen.add(value as object);
  if (Array.isArray(value)) return '[' + value.map((v) => canonicalJson(v, seen)).join(',') + ']';
  const keys = Object.keys(value as Record<string, unknown>).sort();
  return (
    '{' +
    keys.map((k) => JSON.stringify(k) + ':' + canonicalJson((value as Record<string, unknown>)[k], seen)).join(',') +
    '}'
  );
}

export function stableMaterialId(type: string, label: string): string {
  return `mat_${type}_${slug(label)}`;
}

export function revNum(rev: string): number {
  return parseInt(rev.replace(/^r/, ''), 10) || 0;
}

export function makeRev(n: number): string {
  return 'r' + String(n).padStart(3, '0');
}

export function slug(s: string): string {
  return (
    s
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'x'
  );
}

export function seqId(prefix: string, n: number): string {
  return prefix + String(n).padStart(6, '0');
}

/** 决定论顺序：等价输入得到稳定顺序。 */
export function compareStable(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
