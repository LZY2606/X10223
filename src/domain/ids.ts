import { createHash } from 'node:crypto';

/** 确定性内容寻址 id：等价输入得到稳定顺序与稳定身份。 */
export function contentId(prefix: string, parts: unknown[]): string {
  const h = createHash('sha256');
  h.update(canonicalize(parts));
  return `${prefix}_${h.digest('hex').slice(0, 16)}`;
}

export function eventId(projectId: string, seq: number): string {
  return `evt_${short(projectId)}_${String(seq).padStart(5, '0')}`;
}

function short(s: string): string {
  return createHash('sha256').update(s).digest('hex').slice(0, 10);
}

export function canonicalize(v: unknown): string {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return `[${v.map(canonicalize).join(',')}]`;
  const obj = v as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalize(obj[k])}`).join(',')}}`;
}

export function checksumOf(data: Uint8Array | string): string {
  return 'sha256:' + createHash('sha256').update(data).digest('hex');
}
