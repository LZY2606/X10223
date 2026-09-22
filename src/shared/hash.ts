import { createHash } from 'node:crypto';

/** 稳定 JSON：键排序，保证等价输入 -> 相同摘要。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(data: Buffer | string): string {
  return createHash('sha256').update(data).digest('hex');
}

export function contentHash(value: unknown): string {
  return sha256Hex(stableStringify(value));
}

/**
 * 稳定身份：语义前缀 + 短内容哈希。
 * 同一项目导出/删除/再导入后身份保持；等价输入顺序稳定。
 */
export function stableId(kind: string, payload: unknown): string {
  return `${kind}_${contentHash(payload).slice(0, 16)}`;
}

let counter = 0;
/** 事件身份：项目 + 分支 + 序号 + 父事件 + 时间 + 进程计数器。 */
export function eventId(projectId: string, branch: string, seq: number, parentEventId: string | null, createdAt: string): string {
  counter += 1;
  return `evt_${sha256Hex(`${projectId}|${branch}|${seq}|${parentEventId ?? ''}|${createdAt}|${counter}`).slice(0, 20)}`;
}
