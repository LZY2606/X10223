import type { QtyInput, Qty, UnitSystem, Diagnostic } from "../shared/types.js";

const ALIASES: Record<string, UnitSystem> = {
  bp: "bp",
  "base pair": "bp",
  "base pairs": "bp",
  nt: "nt",
  nucleotide: "nt",
  kda: "kDa",
  px: "px",
  pixel: "px",
  pixels: "px",
  mm: "mm",
  ms: "ms",
  s: "s",
  count: "count",
  ratio: "ratio"
};

export function normalizeUnit(unit: string): UnitSystem | null {
  return ALIASES[unit.trim().toLowerCase()] ?? null;
}

export function asQty(
  input: QtyInput,
  path: string,
  diagnostics: Diagnostic[] = []
): Qty {
  const qty: Qty = { value: input.value, unit: input.unit };
  const canonicalUnit = normalizeUnit(input.unit);
  if (!canonicalUnit) {
    qty.convertDiagnostic = `unit ${input.unit} 无已知换算规则`;
    diagnostics.push({
      code: "UNCONVERTIBLE_UNIT",
      severity: "warning",
      path,
      message: `${path}: 无法将单位「${input.unit}」规范化，保留原始表示`
    });
    return qty;
  }
  const numeric = Number(input.value);
  if (!Number.isFinite(numeric)) {
    qty.convertDiagnostic = `value ${input.value} 不是有限数值`;
    qty.canonicalUnit = canonicalUnit;
    diagnostics.push({
      code: "UNCONVERTIBLE_UNIT",
      severity: "error",
      path,
      message: `${path}: 数值「${input.value}」无法转换，保留原始表示`
    });
    return qty;
  }
  qty.valueCanonical = numeric;
  qty.canonicalUnit = canonicalUnit;
  return qty;
}

export function qtyDisplay(qty: Qty): string {
  return `${qty.value} ${qty.unit}`;
}

export function makeQty(value: number, unit: UnitSystem, rawValue?: string, rawUnit?: string): Qty {
  const out: Qty = { value: rawValue ?? String(value), unit: rawUnit ?? unit };
  out.valueCanonical = value;
  out.canonicalUnit = unit;
  return out;
}
