import { createHash } from 'node:crypto';

/** 规范化 JSON：键排序、无空白，保证等价输入得到相同摘要 */
export function canonicalJSON(value: unknown): string {
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

export function sha256Bytes(data: Uint8Array | Buffer): string {
  return createHash('sha256').update(data as Buffer).digest('hex');
}

export function sha256Json(value: unknown): string {
  return createHash('sha256').update(canonicalJSON(value)).digest('hex');
}

/** 材料身份：mat_ + 内容哈希前 16 位；相同字节永远同 id */
export function materialIdFor(kind: string, original: unknown, bytesSha?: string): string {
  const basis = bytesSha ?? sha256Json({ kind, original });
  return `mat_${basis.slice(0, 16)}`;
}

/**
 * 事件身份：仅依赖 (project, seq, parents, type, payload 的规范内容)。
 * 不含 wall-clock 时间，因此重放/导入导出身份稳定。
 */
export function eventIdentity(input: {
  projectId: string;
  seq: number;
  parents: string[];
  type: string;
  payload: unknown;
}): string {
  return `evt_${sha256Json(input).slice(0, 20)}`;
}

/** 稳定排序键：等价输入 → 稳定顺序 */
export function stableCompare<T>(items: T[], key: (t: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
