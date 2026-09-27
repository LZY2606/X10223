import { createHash } from "node:crypto";

export function stableCanonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableCanonical).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, child]) => child !== undefined)
    .sort(([left], [right]) => left.localeCompare(right));
  return `{${entries.map(([key, child]) => `${JSON.stringify(key)}:${stableCanonical(child)}`).join(",")}}`;
}

export function sha256Canonical(value: unknown): string {
  return createHash("sha256").update(stableCanonical(value)).digest("hex");
}

export function shortDigest(value: unknown): string {
  return sha256Canonical(value).slice(0, 12);
}

export function stableId(prefix: string, ...parts: unknown[]): string {
  return `${prefix}_${shortDigest(parts)}`;
}

export function rawUnitValue(value: number | null, unit: string, diagnosticCode?: Parameters<typeof createUnitValue>[2]): import("./types.js").UnitValue {
  return createUnitValue(value, unit, diagnosticCode);
}

function createUnitValue(
  value: number | null,
  unit: string,
  diagnosticCode?: "UNCONVERTIBLE_VALUE"
): import("./types.js").UnitValue {
  const result: import("./types.js").UnitValue = {
    value,
    unit,
    rawText: value === null ? "unavailable" : `${formatNumber(value)} ${unit}`
  };
  if (diagnosticCode) {
    result.conversionDiagnostic = {
      code: diagnosticCode,
      severity: "error",
      path: "unitValue",
      message: "原始表示无法规范化，值保留在原位置。"
    };
  }
  return result;
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(3).replace(/0+$/, "").replace(/\.$/, "");
}
