// 稳定身份：内容哈希 + 单调序号。等价输入 -> 稳定顺序与稳定 id。
export function contentHash(input: unknown): string {
  const s = stableStringify(input);
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = (Math.imul(h2 ^ c, 0x85ebca6b) + i) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export function stableStringify(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(stableStringify).join(',') + ']';
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(o[k])).join(',') + '}';
}

export const materialId = (kind: string, payload: unknown) => `mat_${kind}_${contentHash(payload)}`;
export const seqId = (prefix: string, seq: number) => `${prefix}_${String(seq).padStart(4, '0')}`;
