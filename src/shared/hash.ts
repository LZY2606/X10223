import { createHash } from 'node:crypto';

/**
 * 规范化 JSON：键排序、固定空白，使等价输入在任意机器上得到相同字节序列。
 * 浏览器与 Node 均可调用（不含 Node API），但哈希在下方用 node:crypto 计算。
 */
export function canonicalize(value: unknown): string {
  return stringifySorted(value);
}

function stringifySorted(value: unknown): string {
  if (value === null) return 'null';
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw new TypeError('canonical JSON cannot encode non-finite number');
    }
    return JSON.stringify(value);
  }
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return '[' + value.map(stringifySorted).join(',') + ']';
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>).sort();
    return (
      '{' +
      keys
        .map((k) => JSON.stringify(k) + ':' + stringifySorted((value as Record<string, unknown>)[k]))
        .join(',') +
      '}'
    );
  }
  throw new TypeError('canonical JSON cannot encode ' + typeof value);
}

export function sha256Bytes(data: Uint8Array | Buffer): string {
  return createHash('sha256').update(data as Buffer).digest('hex');
}

export function sha256Text(text: string): string {
  return sha256Bytes(Buffer.from(text, 'utf8'));
}

export function sha256Canonical(value: unknown): string {
  return sha256Text(canonicalize(value));
}

let counter = 0;

/** 短内容身份：prefix + 12 位内容哈希。等价内容得到等价身份。 */
export function stableId(prefix: string, content: unknown): string {
  counter = (counter + 1) % 1_000_000;
  return `${prefix}_${sha256Canonical(content).slice(0, 16)}`;
}
