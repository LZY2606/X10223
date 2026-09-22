import { createHash } from 'node:crypto';

/**
 * 稳定身份（stable identity）。
 * - material / lane / band 的“身份”在所有版本、导出导入往返中保持不变；
 * - 每次修订产生新的版本（revId），历史版本可回放；
 * - 计算结果通过 content hash 去重，等价输入得到等价结果与稳定顺序。
 */
export function sha256Short(...parts: string[]): string {
  return createHash('sha256').update(parts.join(' ')).digest('hex').slice(0, 16);
}

export function revId(identity: string, revision: number): string {
  return `${identity}@r${revision}`;
}

export function isRevId(id: string): boolean {
  return /@r\d+$/.test(id);
}

export function baseIdentity(rev: string): string {
  return rev.replace(/@r\d+$/, '');
}

/** 事件序列号补零，保证字典序即时间顺序（等价输入稳定顺序） */
export function seqId(seq: number): string {
  return `ev-${String(seq).padStart(6, '0')}`;
}

/** 排序候选时使用的稳定 key：状态优先级 + 数值 + 身份 */
export function candidateSortKey(s: {
  bandId: string;
  mwNorm: number | null;
  status: string;
}): string {
  const prio: Record<string, number> = {
    definite: 0,
    interval: 1,
    candidate: 2,
    invalid: 3
  };
  const p = prio[s.status] ?? 9;
  const v = s.mwNorm === null ? 0 : s.mwNorm;
  return `${p}-${String(v).padStart(12, '0')}-${s.bandId}`;
}
