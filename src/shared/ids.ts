import { createHash } from 'node:crypto';

/** 规范化 JSON（键排序）后取 sha256 —— 等价输入得到稳定身份与稳定顺序 */
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

export function sha256Text(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function contentId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256Text(canonicalJson(value)).slice(0, 16)}`;
}

/** 稳定排序键：等价输入得到稳定顺序 */
export function stableSortKey(value: unknown): string {
  return sha256Text(canonicalJson(value));
}
