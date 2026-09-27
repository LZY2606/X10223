// 稳定身份：所有 id 都由规范化 JSON 的 sha256 内容寻址得到。
// 等价输入 -> 相同字节 -> 相同 id 与相同（确定的）顺序；与数据库自增 id 无关。
import { createHash } from "node:crypto";

/** 以键排序的方式规范化（字段顺序无关），undefined 字段剔除。 */
export function stableStringify(value: unknown): string {
  if (value === undefined) return "null";
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "null";
  }
  if (Array.isArray(value)) {
    return "[" + value.map(stableStringify).join(",") + "]";
  }
  const rec = value as Record<string, unknown>;
  const keys = Object.keys(rec)
    .filter((k) => rec[k] !== undefined)
    .sort();
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify(rec[k])).join(",") +
    "}"
  );
}

export function sha256Hex(value: unknown): string {
  return createHash("sha256").update(stableStringify(value)).digest("hex");
}

export function shortHash(value: unknown, prefix = "id"): string {
  return `${prefix}_${sha256Hex(value).slice(0, 16)}`;
}

export function bytesSha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** 确定性比较键：用于把等价输入排成稳定顺序。 */
export function canonicalOrderKey(value: unknown): string {
  return stableStringify(value);
}

export function sortStable<T>(items: T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}
