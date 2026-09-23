import type { Diagnostic } from "./diagnostics.ts";
import { diag } from "./diagnostics.ts";

export type Unit = "bp" | "px" | "kV*h" | "s" | "deg" | "ratio";
export type CoordBasis = "image-raw" | "image-norm";

/** A domain quantity always carries its original textual representation plus unit/basis. */
export interface Quantity {
  raw: string;
  value: number;
  unit: Unit;
  basis?: CoordBasis;
}

export function qty(raw: string, value: number, unit: Unit, basis?: CoordBasis): Quantity {
  return { raw, value, unit, basis };
}

const UNIT_RE = /^(-?\d+(?:\.\d+)?)\s*(bp|px|kV\*h|s|deg|ratio)$/;

/**
 * Parse a raw representation into a normalized quantity.
 * Unconvertible values are NOT dropped: they stay at their original position
 * (caller keeps `raw`) and a positioned diagnostic is returned.
 */
export function parseQuantity(raw: string, expectedUnit: Unit, path: string, basis?: CoordBasis): { quantity: Quantity | null; diagnostics: Diagnostic[] } {
  const m = raw.trim().match(UNIT_RE);
  if (!m) {
    return { quantity: null, diagnostics: [diag("unit-unparseable", `cannot parse quantity '${raw}'`, path)] };
  }
  const value = Number(m[1]);
  const unit = m[2] as Unit;
  if (unit !== expectedUnit) {
    return { quantity: null, diagnostics: [diag("unit-mismatch", `expected ${expectedUnit}, got ${unit} in '${raw}'`, path)] };
  }
  return { quantity: qty(raw, value, unit, basis), diagnostics: [] };
}
