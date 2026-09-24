import { createHash } from 'node:crypto';

/** 规范化 JSON（键排序），保证等价输入得到相同摘要 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function stableHash(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

/** 内容寻址稳定身份：前缀 + 摘要前 12 位 */
export function contentId(prefix: string, value: unknown): string {
  return `${prefix}_${stableHash(value).slice(0, 12)}`;
}
