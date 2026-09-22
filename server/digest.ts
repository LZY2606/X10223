import { createHash, randomUUID } from 'node:crypto';

export function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`;
}

// 内容寻址身份：等价输入得到等价身份与稳定顺序
export function contentId(prefix: string, payload: unknown): string {
  return `${prefix}_${sha256(stableStringify(payload)).slice(0, 16)}`;
}

export function eventId(seq: number, payload: unknown): string {
  return `evt_${String(seq).padStart(4, '0')}_${sha256(stableStringify(payload)).slice(0, 8)}`;
}

export function computationId(kind: string, paramVersion: string, inputIds: string[]): string {
  const sorted = [...inputIds].sort();
  return `cmp_${sha256(`${kind}|${paramVersion}|${sorted.join(',')}`).slice(0, 16)}`;
}

export function newOpId(): string {
  return `op_${randomUUID()}`;
}
