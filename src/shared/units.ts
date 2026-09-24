/**
 * 领域量与单位 / 坐标基准。
 * 导入层保留原始表示；规范化只发生在派生层。
 * 无法转换的值留在原位置并附诊断。
 */

export type UnitTag =
  | "px"
  | "bp"
  | "kDa"
  | "gray8"
  | "deg"
  | "ratio"
  | "ms";

/** 带稳定单位标签的数值；保留原始文本表示。 */
export interface Quantity {
  value: number;
  unit: UnitTag;
  /** 原始表示（导入时不丢失）。 */
  raw: string;
}

export function q(value: number, unit: UnitTag, raw?: string): Quantity {
  return { value, unit, raw: raw ?? String(value) };
}

/** 像素点，坐标基准为某张图像材料的像素系（左上角原点，x 向右、y 向下）。 */
export interface PixelPoint {
  x: number;
  y: number;
  unit: "px";
  frameId: string;
}

/** 像素矩形。 */
export interface PixelBox {
  x: number;
  y: number;
  w: number;
  h: number;
  unit: "px";
  frameId: string;
}

export function px(x: number, y: number, frameId: string): PixelPoint {
  return { x, y, unit: "px", frameId };
}

export function box(
  x: number,
  y: number,
  w: number,
  h: number,
  frameId: string
): PixelBox {
  return { x, y, w, h, unit: "px", frameId };
}

export interface ConversionDiagnostic {
  code: "UNCONVERTIBLE_VALUE";
  severity: "error" | "warning";
  at: string;
  raw: string;
  expectedUnit: UnitTag;
  message: string;
}

const UNIT_PATTERNS: Record<UnitTag, RegExp> = {
  px: /^([+-]?\d+(?:\.\d+)?)\s*(?:px|像素)?$/i,
  bp: /^([+-]?\d+(?:\.\d+)?)\s*(?:bp|碱基对)$/i,
  kDa: /^([+-]?\d+(?:\.\d+)?)\s*(?:kda|kd|千道尔顿)$/i,
  gray8: /^([+-]?\d+(?:\.\d+)?)\s*(?:gray8|灰度)?$/i,
  deg: /^(-?\d+(?:\.\d+)?)\s*(?:deg|°|度)$/i,
  ratio: /^([+-]?\d+(?:\.\d+)?)\s*(?:ratio|倍)?$/i,
  ms: /^([+-]?\d+(?:\.\d+)?)\s*ms$/i
};

/** 解析带单位文本；无法转换时不抛异常，返回诊断。 */
export function parseQuantity(
  raw: string,
  expected: UnitTag,
  at: string
): { quantity?: Quantity; diagnostic?: ConversionDiagnostic } {
  const text = String(raw ?? "").trim();
  const m = UNIT_PATTERNS[expected].exec(text);
  if (!m || !Number.isFinite(Number(m[1]))) {
    return {
      diagnostic: {
        code: "UNCONVERTIBLE_VALUE",
        severity: "error",
        at,
        raw: text,
        expectedUnit: expected,
        message: `无法把 "${text}" 转换为单位 ${expected}；原值保留在 ${at}`
      }
    };
  }
  return { quantity: q(Number(m[1]), expected, text) };
}

/** 以原始表示为键做稳定比较（等价输入得到稳定顺序）。 */
export function compareRaw(a: Quantity, b: Quantity): number {
  if (a.raw !== b.raw) return a.raw < b.raw ? -1 : 1;
  return a.value - b.value;
}
