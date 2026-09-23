import { createHash } from "node:crypto";

/** 稳定序列化：键排序，Uint8Array 以长度+sha256 参与摘要（避免大图重复哈希） */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (value instanceof Uint8Array) {
    return JSON.stringify({ __bytes: value.length, __sha: sha256Hex(value) });
  }
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + stableStringify(obj[k])).join(",") + "}";
}

export function sha256Hex(bytes: Uint8Array | string): string {
  const h = createHash("sha256");
  h.update(typeof bytes === "string" ? Buffer.from(bytes, "utf8") : Buffer.from(bytes));
  return h.digest("hex");
}

/** 内容寻址 id：等价输入得到等价 id（稳定顺序的基础） */
export function contentId(prefix: string, content: unknown): string {
  return `${prefix}_${sha256Hex(stableStringify(content)).slice(0, 16)}`;
}

export function stableHashOf(content: unknown): string {
  return sha256Hex(stableStringify(content));
}

/** 确定性排序键：等价输入得到稳定顺序 */
export function compareStable<T extends { id?: string; bandId?: string; inferenceId?: string }>(
  a: T,
  b: T
): number {
  return String(a.id ?? a.bandId ?? a.inferenceId).localeCompare(
    String(b.id ?? b.bandId ?? b.inferenceId)
  );
}
