import type { Diagnostic, Quantity, Unit } from "./types";

/** 单位解析：导入时保留原始表示，派生层才规范化。
 *  无法转换的值留在原位置并附诊断，不为画图丢掉。 */

const SIZE_ALIASES: Record<string, { unit: Unit; factor: number }> = {
  bp: { unit: "bp", factor: 1 },
  kbp: { unit: "bp", factor: 1000 },
  kb: { unit: "bp", factor: 1000 },
  kda: { unit: "kDa", factor: 1 },
  da: { unit: "kDa", factor: 0.001 },
};

export interface ParsedSize {
  quantity: Quantity;
  diagnostics: Diagnostic[];
}

/** 解析 "1000 bp"、"1.5kb"、"10 kDa" 等原始表示 */
export function parseSize(raw: string, location: string): ParsedSize {
  const diagnostics: Diagnostic[] = [];
  const m = raw.trim().match(/^([0-9]*\.?[0-9]+)\s*([a-zA-Z]+)?$/);
  if (!m) {
    diagnostics.push({
      code: "UNIT_UNPARSEABLE",
      message: `无法解析的标称值 "${raw}"，保留原始表示，不参与规范化`,
      location,
      severity: "error",
    });
    return { quantity: { value: NaN, unit: "bp", raw }, diagnostics };
  }
  const value = parseFloat(m[1]);
  const unitRaw = (m[2] ?? "bp").toLowerCase();
  const alias = SIZE_ALIASES[unitRaw];
  if (!alias) {
    diagnostics.push({
      code: "UNIT_UNKNOWN",
      message: `未知单位 "${m[2]}"，值 "${raw}" 保留在原位置`,
      location,
      severity: "error",
    });
    return { quantity: { value, unit: "bp", raw }, diagnostics };
  }
  return {
    quantity: { value: value * alias.factor, unit: alias.unit, raw },
    diagnostics,
  };
}

/** 曝光解析：保留原始表示 */
export function parseExposure(raw: string, location: string): ParsedSize {
  const m = raw.trim().match(/^([0-9]*\.?[0-9]+)\s*(ms|s|sec)?$/i);
  if (!m) {
    return {
      quantity: { value: NaN, unit: "s", raw },
      diagnostics: [{
        code: "EXPOSURE_UNPARSEABLE",
        message: `无法解析的曝光 "${raw}"`,
        location,
        severity: "error",
      }],
    };
  }
  const v = parseFloat(m[1]);
  const unit = (m[2] ?? "s").toLowerCase();
  return {
    quantity: { value: unit === "ms" ? v / 1000 : v, unit: "s", raw },
    diagnostics: [],
  };
}
