import { createHash } from 'node:crypto';

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

/** 稳定 JSON 序列化（键排序），用于身份与摘要计算。 */
export function canonicalize(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

/** sha256 摘要，等价输入必得等价摘要。 */
export function digest(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

/** 由内容派生的稳定身份。 */
export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${digest(value).slice(0, 20)}`;
}
