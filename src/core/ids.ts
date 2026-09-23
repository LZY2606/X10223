import { createHash } from 'node:crypto';

/** 稳定 JSON 序列化：键排序，保证等价输入得到等价摘要。 */
export function stableStringify(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(v: unknown): unknown {
  if (Array.isArray(v)) return v.map(sortDeep);
  if (v && typeof v === 'object') {
    const out: Record<string, unknown> = {};
    for (const k of Object.keys(v as Record<string, unknown>).sort()) {
      out[k] = sortDeep((v as Record<string, unknown>)[k]);
    }
    return out;
  }
  return v;
}

export function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex');
}

/** 内容寻址身份：同类实体同内容必同 id，跨导出/导入稳定。 */
export function contentId(kind: string, payload: unknown): string {
  return `${kind}_${sha256(kind + ':' + stableStringify(payload)).slice(0, 24)}`;
}

/** 输入摘要：记录每次计算的完整输入指纹。 */
export function inputDigest(inputs: unknown): string {
  return sha256(stableStringify(inputs));
}
