import { contentId } from "./ids.js";

export type Dimension = "mass-fragment" | "mass-protein" | "length" | "angle" | "time" | "pixel" | "dimensionless";

export interface UnitDef {
  name: string;
  dimension: Dimension;
  toBase: number;
}

export const UNITS: Record<string, UnitDef> = {
  bp: { name: "bp", dimension: "mass-fragment", toBase: 1 },
  kb: { name: "kb", dimension: "mass-fragment", toBase: 1000 },
  kDa: { name: "kDa", dimension: "mass-protein", toBase: 1 },
  Da: { name: "Da", dimension: "mass-protein", toBase: 0.001 },
  px: { name: "px", dimension: "pixel", toBase: 1 },
  deg: { name: "deg", dimension: "angle", toBase: 1 },
  ms: { name: "ms", dimension: "time", toBase: 1 },
  s: { name: "s", dimension: "time", toBase: 1000 }
};

export type QtyStatus = "ok" | "unconvertible";

export interface Qty {
  id: string;
  raw: string;
  status: QtyStatus;
  value: number | null;
  unit: string | null;
  baseValue: number | null;
  baseUnit: string | null;
  dimension: Dimension | null;
  note: string | null;
}

const NUMBER_RE = /^\s*([+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?)\s*([A-Za-zµμ%\.]+)?\s*$/;

export function parseQty(raw: string, note: string | null = null): Qty {
  const trimmed = raw.trim();
  const match = NUMBER_RE.exec(trimmed);
  const base = { id: contentId("qty", { raw: trimmed }), raw: trimmed, note };
  if (!match) {
    return { ...base, status: "unconvertible", value: null, unit: null, baseValue: null, baseUnit: null, dimension: null };
  }
  const value = Number(match[1]);
  const unit = (match[2] ?? "").replace("μ", "u");
  const def = unit === "" ? { name: "", dimension: "dimensionless" as Dimension, toBase: 1 } : UNITS[unit];
  if (!def) {
    return { ...base, status: "unconvertible", value, unit: unit || null, baseValue: null, baseUnit: null, dimension: null };
  }
  const baseUnit = def.dimension === "mass-fragment" ? "bp" : def.dimension === "mass-protein" ? "kDa" : def.dimension === "time" ? "ms" : def.dimension === "dimensionless" ? "" : def.name;
  return {
    ...base,
    status: "ok",
    value,
    unit: def.name,
    baseValue: value * def.toBase,
    baseUnit,
    dimension: def.dimension
  };
}

export function qtyFromValue(value: number, unit: string, note: string | null = null): Qty {
  return parseQty(`${value} ${unit}`, note);
}

export function formatQty(q: Qty | null | undefined): string {
  if (!q) return "∅";
  if (q.status !== "ok" || q.value === null || !q.unit) return q.raw;
  return `${roundSig(q.value, 6)} ${q.unit}`;
}

export function roundSig(n: number, digits: number): number {
  if (!Number.isFinite(n)) return n;
  const f = 10 ** digits;
  return Math.round(n * f) / f;
}
