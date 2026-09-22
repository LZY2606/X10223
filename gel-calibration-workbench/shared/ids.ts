// 稳定身份：FNV-1a 64bit（确定性、跨导入导出保持）；字节完整性用 sha256（服务端注入实现）

const FNV_PRIME = 0x100000001b3n;
const FNV_OFFSET = 0xcbf29ce484222325n;
const U64 = 0xffffffffffffffffn;

/** 规范化 JSON（键排序），保证等价输入得到稳定摘要 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return '[' + value.map(canonicalJson).join(',') + ']';
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return '{' + entries.map(([k, v]) => JSON.stringify(k) + ':' + canonicalJson(v)).join(',') + '}';
}

export function fnv1a64(input: string): string {
  let hash = FNV_OFFSET;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = BigInt.asUintN(64, hash * FNV_PRIME);
  }
  return hash.toString(16).padStart(16, '0');
}

/** 稳定 id：前缀 + 规范化内容哈希 */
export function stableId(prefix: string, value: unknown): string {
  return `${prefix}_${fnv1a64(canonicalJson(value))}`;
}

/** 有序列表的稳定组合哈希 */
export function combine(parts: string[]): string {
  return fnv1a64(parts.join('|'));
}

export function nowIso(): string {
  return new Date(0).toISOString(); // 确定性时间基准：派生计算时间不参与身份
}

export function sortStable<T>(items: T[], key: (t: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export const METHOD_VERSION = 'detect-1.0.0';
export const PARAMS_SCHEMA_VERSION = 'calibration-params-1.0.0';
