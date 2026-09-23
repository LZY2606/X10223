import { createHash } from 'node:crypto';

/** 稳定 JSON（键排序）→ sha256。输入摘要用于依赖失效判断。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function digestOf(value: unknown): string {
  return createHash('sha256').update(canonical(value)).digest('hex').slice(0, 24);
}

let counter = 0;
/** 稳定身份：由内容摘要 + 单调序号生成，导出/导入后保持不变。 */
export function stableId(prefix: string, content: unknown, seq: number): string {
  return `${prefix}_${String(seq).padStart(4, '0')}_${digestOf(content).slice(0, 8)}`;
}
export function nextSeqHint(): number {
  return ++counter;
}
