import { createHash } from 'node:crypto';

/** 规范化 JSON（键排序），保证等价输入得到等价摘要与稳定顺序。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(obj[k])}`).join(',')}}`;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

export function shortHash(text: string, len = 20): string {
  return sha256(text).slice(0, len);
}

/** 材料身份 = 内容寻址，等价内容等价身份。 */
export function materialId(kind: string, content: unknown): string {
  return `mat_${shortHash(`${kind}:${canonical(content)}`)}`;
}

/** 计算身份 = 种类 + 参数版本 + 输入摘要，保证可重放与局部失效。 */
export function computationId(kind: string, paramVersion: string, inputDigest: string): string {
  return `cmp_${shortHash(`${kind}@${paramVersion}:${inputDigest}`)}`;
}

export function decisionId(targetId: string, branch: string, seq: number, payload: unknown): string {
  return `dec_${shortHash(`${targetId}|${branch}|${seq}|${canonical(payload)}`)}`;
}

export function eventHash(prevHash: string, type: string, payload: unknown): string {
  return shortHash(`${prevHash}|${type}|${canonical(payload)}`, 32);
}
