import { createHash } from 'node:crypto';

/** 稳定 JSON 序列化：键序递归排序，保证等价输入得到等价摘要。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 内容寻址身份：同一内容永远得到同一 id，导出/导入后身份稳定。 */
export function contentId(prefix: string, value: unknown): string {
  return `${prefix}_${sha256(canonical(value)).slice(0, 16)}`;
}

let eventCounter = 0;
/** 事件 id：由序号与内容共同决定，重放时稳定。 */
export function eventId(seq: number, type: string, payload: unknown): string {
  const h = sha256(canonical({ seq, type, payload })).slice(0, 10);
  eventCounter += 1;
  return `evt_${String(seq).padStart(5, '0')}_${h}`;
}
