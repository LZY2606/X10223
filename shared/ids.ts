import { createHash } from 'node:crypto';

/** 稳定字符串化：对象键排序，保证等价输入得到等价摘要。 */
export function canonical(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + canonical(obj[k])).join(',') + '}';
}

export function sha256hex(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function digestOf(value: unknown): string {
  return sha256hex(canonical(value)).slice(0, 16);
}

export function materialId(streamId: string, version: number): string {
  return `mat_${streamId.replaceAll('/', '_')}_v${version}`;
}

export function eventId(seq: number): string {
  return `evt_${String(seq).padStart(6, '0')}`;
}

export function computationId(subject: string, inputsResolved: unknown, paramVersion: string): string {
  return `cmp_${digestOf({ subject, inputs: inputsResolved, paramVersion })}`;
}

export function decisionId(subject: string, reviewer: string, seq: number): string {
  return `dec_${digestOf({ subject, reviewer, seq })}`;
}

/** 确定性逻辑时钟：保证导出/导入往返后字节级一致。 */
export function isoFromSeq(seq: number): string {
  return new Date(Date.UTC(2026, 8, 24, 0, 0, 0) + seq * 1000).toISOString();
}
