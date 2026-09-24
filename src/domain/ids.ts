import { createHash, randomUUID } from "node:crypto";

export function uuid(): string {
  return randomUUID();
}

/** 派生结果身份：对算法版本、输入摘要、参数与父级依赖做内容寻址 */
export function contentId(parts: unknown[]): string {
  const json = stableStringify(parts);
  return "c_" + createHash("sha256").update(json).digest("hex").slice(0, 24);
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return (
    "{" +
    keys
      .map((k) => JSON.stringify(k) + ":" + stableStringify(record[k]))
      .join(",") +
    "}"
  );
}

/** 等价输入 → 稳定顺序：按字符串键排序 */
export function stableSort<T>(items: T[], key: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = key(a);
    const kb = key(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

export function hashBytes(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}
