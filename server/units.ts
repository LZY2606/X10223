import type { Quantity } from "./types.ts";

export type BpConversion =
  | { ok: true; bp: number }
  | { ok: false; reason: string };

/** Normalize a quantity to base pairs. Unconvertible values stay in place (caller keeps raw). */
export function toBp(q: Quantity): BpConversion {
  if (typeof q.value !== "number" || !Number.isFinite(q.value)) {
    return { ok: false, reason: `value is not a finite number: ${String(q.raw ?? q.value)}` };
  }
  if (q.unit === "bp") return { ok: true, bp: q.value };
  if (q.unit === "kb") return { ok: true, bp: q.value * 1000 };
  return { ok: false, reason: `cannot convert unit '${q.unit}' to bp` };
}
