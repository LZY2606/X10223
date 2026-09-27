import { createHash } from 'node:crypto';

/** 稳定 JSON：键排序、无多余空白，保证等价输入得到稳定身份与稳定顺序 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortKeys((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(payload: string | Uint8Array): string {
  return createHash('sha256').update(payload as never).digest('hex');
}

/** 内容寻址身份：sha256 摘要 + 短前缀（带类型前缀避免跨类型碰撞） */
export function contentId(prefix: string, content: unknown): string {
  const h = sha256Hex(stableStringify(content)).slice(0, 16);
  return `${prefix}_${h}`;
}

/** 事件身份包含父级（链式），使分支/决定历史不可重写 */
export function eventId(branchId: string, seq: number, clock: number, parentIds: string[], payload: unknown): string {
  return contentId('evt', { branchId, seq, clock, parentIds, payload });
}

/** 稳定排序：等价输入 -> 稳定顺序 */
export function sortById<T extends { id: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
}
