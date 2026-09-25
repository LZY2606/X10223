import { createHash } from "node:crypto";
import { canonicalJson } from "./canonical.js";

export function sha256Hex(data: string | Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

export function digestOf(value: unknown): string {
  return sha256Hex(canonicalJson(value));
}

export function contentId(prefix: string, payload: unknown): string {
  return `${prefix}_${sha256Hex(canonicalJson(payload)).slice(0, 32)}`;
}

export function stableUuidHex(seed: unknown): string {
  const hex = sha256Hex(canonicalJson(seed));
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
