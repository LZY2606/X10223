import type { Quantity, QuantityUnit } from "./types.js";

/** 解析带单位的原始表示；无法转换时返回 null（保留原位置，由上层附诊断） */
export function parseQuantity(raw: string): {
  parsed: Quantity | null;
  unit: QuantityUnit | null;
} {
  const m = raw.match(/^\s*([-+]?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*([A-Za-z%]+)\s*$/);
  if (!m) return { parsed: null, unit: null };
  const value = Number(m[1]);
  const rawUnit = m[2];
  const unit = canonicalUnit(rawUnit);
  if (!unit) return { parsed: null, unit: null };
  return { parsed: { value, unit }, unit };
}

function canonicalUnit(u: string): QuantityUnit | null {
  switch (u) {
    case "bp":
    case "bps":
      return "bp";
    case "kDa":
    case "kD":
      return "kDa";
    case "ms":
      return "ms";
    case "deg":
    case "°":
      return "deg";
    case "px":
    case "pixel":
      return "pixel";
    case "eV":
      return "eV";
    default:
      return null;
  }
}

export function isFiniteQuantity(q: Quantity | null): boolean {
  return !!q && Number.isFinite(q.value);
}
