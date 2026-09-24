import type { Diagnostic, Quantity, SourceLoc } from "../types.ts";

/**
 * 解析带单位的量。原始表示保留；无法转换时 value=null 并生成带位置诊断，
 * 绝不用空值或默认值伪装成功。
 */
export function parseQuantity(raw: string, allowed: string[], loc?: SourceLoc): { q: Quantity; d?: Diagnostic } {
  const trimmed = raw.trim();
  const m = /^([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*([^\s]+)?$/.exec(trimmed);
  if (!m) {
    const q: Quantity = { value: null, unit: allowed[0] ?? "", raw, loc };
    return {
      q,
      d: {
        code: "quantity.unparseable",
        severity: "error",
        message: `无法把 ${JSON.stringify(trimmed)} 解析为数值+单位；原值保留在原位置`,
        loc,
        failureClass: "format-corrupt",
      },
    };
  }
  const num = Number(m[1]);
  const unit = (m[2] ?? allowed[0] ?? "").trim();
  if (!allowed.includes(unit)) {
    const q: Quantity = { value: null, unit, raw, loc };
    return {
      q,
      d: {
        code: "quantity.unknown-unit",
        severity: "error",
        message: `单位 ${JSON.stringify(unit)} 不可转换为 ${allowed.join("/")}；原值保留`,
        loc,
        failureClass: "semantic-unsolvable",
      },
    };
  }
  return { q: { value: num, unit, raw, loc } };
}

export function q(value: number, unit: string): Quantity {
  return { value, unit, raw: formatRaw(value, unit) };
}

export function formatRaw(value: number, unit: string): string {
  return `${round6(value)} ${unit}`;
}

export function round6(n: number): number {
  return Math.round(n * 1e6) / 1e6;
}

export function withValue(quantity: Quantity, value: number): Quantity {
  return { ...quantity, value: round6(value), raw: formatRaw(value, quantity.unit) };
}
