import { createHash } from 'node:crypto';

/** 规范 JSON：对象键排序、无空白，保证跨平台等价输入得到相同摘要。 */
export function canonicalJSON(value: unknown): string {
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

export function sha256Hex(data: string | Uint8Array): string {
  const h = createHash('sha256');
  h.update(data as any);
  return h.digest('hex');
}

export function contentId(prefix: string, value: unknown): string {
  return `${prefix}:${sha256Hex(canonicalJSON(value)).slice(0, 24)}`;
}

let counter = 0;
export function uniqueId(prefix: string): string {
  counter += 1;
  return `${prefix}_${Date.now().toString(36)}_${counter.toString(36)}_${Math.floor(Math.random() * 1e6).toString(36)}`;
}
