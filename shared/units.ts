// 领域单位：导入时保留原始表示，派生层才做规范化；无法转换的值留在原位置并附诊断。
import type { Quantity, Unit } from "./types";

const MASS_TO_DA: Record<string, number> = {
  da: 1,
  kda: 1000,
  md: 1_000_000,
  gmol: 0 // 需要分子量信息，不自动换算
};

const LENGTH_TO_PX: Record<string, number> = { px: 1, pixel: 1, pixels: 1 };

export function molecularMassUnit(label = "kDa"): Unit {
  return { kind: "molecularMass", label };
}
export function pixelUnit(): Unit {
  return { kind: "pixels", label: "px" };
}
export function timeUnit(label = "ms"): Unit {
  return { kind: "time", label };
}
export function unitless(): Unit {
  return { kind: "unitless", label: "" };
}

export function parseQuantity(raw: string, expected: Unit["kind"]): Quantity {
  const trimmed = raw.trim();
  const match = /^([-+]?\d*\.?\d+(?:[eE][-+]?\d+)?)\s*([A-Za-zμ°/²^0-9.]*)$/.exec(trimmed);
  if (!match) {
    return { raw: trimmed, unit: { kind: expected, label: "" }, diagnostic: "unparseable-quantity" };
  }
  const value = Number(match[1]);
  const label = (match[2] || "").trim();
  const unit: Unit = { kind: expected, label };
  let scaleToBase: number | undefined;
  let diagnostic: string | undefined;
  const key = label.toLowerCase().replace("μ", "u");
  if (expected === "molecularMass") {
    if (key in MASS_TO_DA) {
      scaleToBase = MASS_TO_DA[key];
      if (scaleToBase === 0) {
        scaleToBase = undefined;
        diagnostic = "non-convertible-unit";
      }
    } else {
      diagnostic = "unknown-unit";
    }
  } else if (expected === "pixels") {
    scaleToBase = LENGTH_TO_PX[key] ?? 1;
  }
  if (!Number.isFinite(value) || value <= 0) diagnostic = diagnostic ?? "non-positive-value";
  return { raw: trimmed, value, unit, scaleToBase, diagnostic };
}

export function toBase(q: Quantity): number | undefined {
  if (typeof q.value !== "number" || typeof q.scaleToBase !== "number") return undefined;
  return q.value * q.scaleToBase;
}

export function quantityFromBase(base: number, unitLabel: string, expected: Unit["kind"]): Quantity {
  const scale =
    expected === "molecularMass" ? MASS_TO_DA[unitLabel.toLowerCase()] ?? 1 : 1;
  const value = base / scale;
  return {
    raw: `${roundSig(value)} ${unitLabel}`.trim(),
    value,
    unit: { kind: expected, label: unitLabel },
    scaleToBase: scale || undefined
  };
}

function roundSig(n: number): string {
  if (n === 0) return "0";
  const abs = Math.abs(n);
  const digits = abs >= 100 ? 0 : abs >= 10 ? 1 : 2;
  return n.toFixed(digits);
}

export function formatQuantity(q: Quantity): string {
  if (typeof q.value === "number" && q.unit.label) return `${roundSig(q.value)} ${q.unit.label}`;
  return q.raw;
}
