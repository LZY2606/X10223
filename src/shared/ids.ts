import { createHash, randomUUID } from "node:crypto";
import { canonicalJSON, utf8 } from "./canon.js";

export function sha256Hex(data: Uint8Array | string): string {
  const bytes = typeof data === "string" ? utf8(data) : data;
  return createHash("sha256").update(bytes).digest("hex");
}

const CROCKFORD = "0123456789abcdefghjkmnpqrstvwxyz";

export function shortHashHex(hex: string, length = 16): string {
  return hex.slice(0, length);
}

export function stableId(prefix: string, ...parts: unknown[]): string {
  const hex = sha256Hex(canonicalJSON(parts));
  let num = BigInt("0x" + hex.slice(0, 24));
  let out = "";
  while (num > 0n) {
    out = CROCKFORD[Number(num % 32n)] + out;
    num /= 32n;
  }
  return `${prefix}_${out.padStart(20, "0").slice(0, 20)}`;
}

export const newUuid = randomUUID;
