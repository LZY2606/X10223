// 稳定身份：等价输入 -> 稳定哈希/顺序。浏览器与 Node 均可运行。
export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return '[' + value.map(stableStringify).join(',') + ']';
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return '{' + keys.map((k) => JSON.stringify(k) + ':' + stableStringify(obj[k])).join(',') + '}';
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text);
  const subtle = (globalThis as any).crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest('SHA-256', bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  const { createHash } = await import('node:crypto');
  return createHash('sha256').update(bytes).digest('hex');
}

export async function contentId(prefix: string, value: unknown): Promise<string> {
  return prefix + '_' + (await sha256Hex(stableStringify(value))).slice(0, 20);
}

/** 确定性的短标识：同一逻辑引用在重新生成时保持稳定 */
export function logicalId(prefix: string, ...parts: Array<string | number>): string {
  return `${prefix}_${parts.map(String).join('_')}`;
}
