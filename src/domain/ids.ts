/** 稳定身份：FNV-1a 64 位哈希（纯 TS，浏览器/服务端一致）。
 *  所有实体 ID 由内容派生，等价输入得到稳定顺序与稳定身份。 */

export function fnv1a(input: string): string {
  let h1 = 0x811c9dc5 >>> 0;
  let h2 = 0x01000193 >>> 0; // 用两个 32 位通道模拟 64 位
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ (c & 0xff), 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c >> 8), 0x01000193) >>> 0;
    h1 = (h1 + h2) >>> 0;
    h2 = (h2 + ((h1 << 3) >>> 0)) >>> 0;
  }
  return h1.toString(16).padStart(8, "0") + h2.toString(16).padStart(8, "0");
}

/** 规范化 JSON：键排序，保证等价输入哈希一致 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonicalJson).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonicalJson(obj[k])).join(",") + ")";
}

export function materialId(kind: string, payload: unknown): string {
  return `mat-${kind}-${fnv1a(canonicalJson({ kind, payload }))}`;
}

export function eventId(payload: unknown): string {
  return `evt-${fnv1a(canonicalJson(payload))}`;
}

export function computationId(payload: unknown): string {
  return `cmp-${fnv1a(canonicalJson(payload))}`;
}

/** 稳定排序键：等价输入得到稳定顺序 */
export function stableSort<T>(items: T[], key: (t: T) => string): T[] {
  return [...items].sort((a, b) => (key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0));
}
