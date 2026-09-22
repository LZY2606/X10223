import { createHash } from 'node:crypto';

/**
 * 确定性身份与规范化序列化。
 * 身份全部由内容派生，保证“等价输入得到稳定顺序/身份”，
 * 且导出→删除→导入后身份一致。
 */

export function sha256Hex(...parts: Array<string | Uint8Array>): string {
  const h = createHash('sha256');
  for (const p of parts) h.update(p);
  return h.digest('hex');
}

export function shortHash(...parts: Array<string | Uint8Array>): string {
  return sha256Hex(...parts).slice(0, 16);
}

/** 规范 JSON：对象键按码点排序，保证字节级稳定。 */
export function canonicalJSON(value: unknown): string {
  return JSON.stringify(collapse(value));
}

function collapse(value: unknown): unknown {
  if (value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map(collapse);
  const obj = value as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj).sort()) out[key] = collapse(obj[key]);
  return out;
}

export function contentId(prefix: string, ...parts: Array<string | Uint8Array>): string {
  return `${prefix}_${shortHash(...parts)}`;
}
