import { createHash } from 'node:crypto';

/** 规范化 JSON：键排序，保证等价输入得到稳定摘要与稳定顺序。 */
export function stableStringify(value: unknown): string {
  const seen = new WeakSet<object>();
  const sort = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(sort);
    if (v && typeof v === 'object') {
      if (seen.has(v as object)) throw new Error('cyclic value in stableStringify');
      seen.add(v as object);
      const out: Record<string, unknown> = {};
      for (const key of Object.keys(v as Record<string, unknown>).sort()) {
        out[key] = sort((v as Record<string, unknown>)[key]);
      }
      return out;
    }
    return v;
  };
  return JSON.stringify(sort(value));
}

export function sha256Hex(value: string | Uint8Array): string {
  const h = createHash('sha256');
  h.update(value as any);
  return h.digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

export function stableId(prefix: string, parts: unknown[]): string {
  return `${prefix}_${sha256Hex(stableStringify(parts)).slice(0, 16)}`;
}
