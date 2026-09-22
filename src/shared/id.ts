import { createHash } from 'node:crypto';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

/** 不可变材料的身份 = 内容摘要 */
export function materialId(kind: string, content: Buffer | string): string {
  const body = typeof content === 'string' ? Buffer.from(content, 'utf8') : content;
  return `mat_${kind}_${sha256(body).slice(0, 24)}`;
}

/** 事件身份 = 父级 + 负载 + 参数版本的摘要，等价输入得到稳定身份与顺序 */
export function eventId(kind: string, payload: unknown, parents: string[], paramsVersion: string): string {
  const canonical = stableStringify({ kind, payload, parents, paramsVersion });
  return `evt_${sha256(canonical).slice(0, 24)}`;
}

export function resultId(eventIdStr: string, index: number): string {
  return `res_${sha256(`${eventIdStr}#${index}`).slice(0, 24)}`;
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}
