import { createHash } from "node:crypto";

export function sha256Hex(data: Uint8Array | string): string {
  return createHash("sha256").update(data).digest("hex");
}

const CROCKFORD = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";

/** 26 字符 Crockford Base32 ULID（时间序 + 随机）。 */
export function ulid(at: Date | number = Date.now()): string {
  const t = typeof at === "number" ? at : at.getTime();
  let timePart = "";
  let rest = t;
  for (let i = 0; i < 10; i++) {
    timePart = CROCKFORD[rest % 32] + timePart;
    rest = Math.floor(rest / 32);
  }
  let randPart = "";
  for (let i = 0; i < 16; i++) randPart += CROCKFORD[Math.floor(Math.random() * 32)];
  return timePart + randPart;
}

/**
 * 确定性 ID：同一输入永远得到同一身份（等价输入稳定顺序的基础）。
 * 由调用方提供 canonicalParts（字符串数组，顺序稳定）。
 */
export function contentId(prefix: string, canonicalParts: (string | number | boolean | null)[]): string {
  const canonical = JSON.stringify(canonicalParts);
  return `${prefix}_${sha256Hex(canonical).slice(0, 20)}`;
}

export function hashJson(value: unknown): string {
  return sha256Hex(canonicalJsonStringify(value));
}

/** 稳定 JSON：键排序、无空格、保留数组顺序。 */
export function canonicalJsonStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJsonStringify).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJsonStringify(v)}`).join(",")}}`;
}
