import { createHash } from "node:crypto";

export function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).sort();
  return "{" + keys.map((k) => JSON.stringify(k) + ":" + canonical(obj[k])).join(",") + "}";
}

export function shortHash(text: string): string {
  return createHash("sha256").update(text).digest("hex").slice(0, 24);
}

export function contentId(prefix: string, payload: unknown): string {
  return `${prefix}_${shortHash(canonical(payload))}`;
}
