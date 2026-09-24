import { createHash } from 'node:crypto';

/**
 * 稳定身份：同一组输入永远得到同一个 id。
 * 形式：`kind:sha1前16位`，kind 限定小写领域前缀。
 */
export function makeId(kind: string, ...parts: unknown[]): string {
  const h = createHash('sha1');
  for (const p of parts) {
    h.update(typeof p === 'string' ? p : stableStringify(p));
    h.update('');
  }
  return `${kind}:${h.digest('hex').slice(0, 16)}`;
}

/** 键序稳定的 JSON 序列化，保证等价输入得到等价摘要。 */
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

export function contentHash(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function sha256Hex(buf: Buffer | Uint8Array | string): string {
  return createHash('sha256').update(buf).digest('hex');
}
