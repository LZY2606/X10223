import { createHash } from 'node:crypto';

/**
 * 规范化 JSON：键排序、无多余空白。等价输入产生相同摘要 ——
 * 计算结果内容寻址与“等价输入得到稳定顺序”的基础。
 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const enc = (v: unknown): string => {
    if (v === null) return 'null';
    if (typeof v === 'number') return Number.isFinite(v) ? JSON.stringify(v) : 'null';
    if (typeof v === 'boolean' || typeof v === 'string') return JSON.stringify(v);
    if (Array.isArray(v)) return `[${v.map(enc).join(',')}]`;
    if (typeof v === 'object') {
      if (seen.has(v as object)) throw new Error('cyclic object in stableStringify');
      seen.add(v as object);
      const keys = Object.keys(v as Record<string, unknown>).sort();
      return `{${keys.map((k) => `${JSON.stringify(k)}:${enc((v as Record<string, unknown>)[k])}`).join(',')}}`;
    }
    return 'null';
  };
  return enc(value);
}

export function sha256Of(value: unknown): string {
  return createHash('sha256').update(stableStringify(value)).digest('hex');
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}
