import { createHash } from "node:crypto";

/** 规范化 JSON：键排序，保证等价输入得到稳定摘要/顺序/身份。 */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortDeep(value));
}

function sortDeep(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortDeep);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortDeep((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256Hex(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
export function sha12(value: string | Buffer): string {
  return sha256Hex(value).slice(0, 12);
}

export function prefixedId(prefix: string, material: unknown): string {
  return `${prefix}_${sha12(canonicalJson(material))}`;
}
