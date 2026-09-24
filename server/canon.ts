import { createHash } from "node:crypto";

/** Canonical JSON: recursively sorted keys, so equivalent values hash identically. */
export function canonical(value: unknown): string {
  return JSON.stringify(sortValue(value));
}

function sortValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortValue);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      out[key] = sortValue((value as Record<string, unknown>)[key]);
    }
    return out;
  }
  return value;
}

export function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256(canonical(value));
}

/** Deterministic short id from arbitrary parts. */
export function shortId(prefix: string, ...parts: unknown[]): string {
  const body = parts
    .map((p) => (typeof p === "string" ? p : canonical(p)))
    .join("|");
  return `${prefix}_${sha256(body).slice(0, 16)}`;
}
