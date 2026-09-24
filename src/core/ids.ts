import { createHash } from 'node:crypto';

/** 规范化 JSON（键排序），用于输入摘要与稳定身份。 */
export function canonicalize(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map(canonicalize).join(',')}]`;
  const obj = value as Record<string, unknown>;
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`)
    .join(',')}}`;
}

export function sha256Hex(value: unknown): string {
  return createHash('sha256').update(canonicalize(value)).digest('hex');
}

export function shortHash(value: unknown): string {
  return sha256Hex(value).slice(0, 12);
}

export function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** 派生结果稳定身份：仅依赖输入摘要/参数版本/父级，等价输入 ⇒ 同一身份与稳定顺序。 */
export function derivedId(prefix: string, parts: unknown[]): string {
  return `${prefix}_${shortHash(parts)}`;
}

let counter = 0;
/** 命令事件身份：时间序 + 进程内计数 + 随机熵，保证全局唯一。 */
export function commandId(prefix: string, now = Date.now()): string {
  counter = (counter + 1) % 0xffffff;
  const rand = Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0');
  return `${prefix}_${now.toString(36)}${counter.toString(16).padStart(4, '0')}${rand}`;
}
