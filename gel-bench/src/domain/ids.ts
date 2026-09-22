import { createHash } from 'node:crypto';

/**
 * 稳定身份：所有身份都由内容/逻辑决定，不含墙钟时间或随机数。
 * 等价输入 -> 等价身份与等价顺序（导出/删除/再导入后保持）。
 */
export function sha256Hex(payload: string): string {
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

export function contentId(kind: string, body: unknown): string {
  return `${kind}_${sha256Hex(canonical(body)).slice(0, 20)}`;
}

/** JSON canonicalization：键排序，保证等价对象序列化一致 */
export function canonical(value: unknown): string {
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
  return value === undefined ? null : value;
}

/** 事件/派生结果身份 = 项目 + 父链 + 载荷，保证可重放与稳定顺序 */
export function eventId(projectId: string, parentId: string | null, seq: number, payload: unknown): string {
  return `evt_${sha256Hex(canonical({ projectId, parentId, seq, payload })).slice(0, 20)}`;
}

export function derivedId(kind: string, inputs: unknown): string {
  return contentId(`der_${kind}`, inputs);
}
