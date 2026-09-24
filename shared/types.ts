/** 坐标基准：图像像素坐标，原点左上，y 轴向下。 */
export interface PixelBasis {
  kind: "image-px";
  origin: "top-left";
  yAxis: "down";
  width: number;
  height: number;
}

/** 带位置的诊断：location 至少给出 path，可附带 laneIndex / y 等。 */
export interface Diagnostic {
  code: string;
  severity: "error" | "warning" | "info";
  message: string;
  location: Record<string, string | number | boolean>;
}

/**
 * 计算结果。资源预算耗尽、格式损坏、语义无解是三种不同的结果；
 * 输入不完整单独成类，绝不用空值或默认值伪装成功。
 */
export type ComputeResult<T> =
  | { kind: "ok"; value: T; diagnostics: Diagnostic[] }
  | { kind: "incomplete-input"; diagnostics: Diagnostic[] }
  | { kind: "budget-exhausted"; diagnostics: Diagnostic[] }
  | { kind: "format-corrupt"; diagnostics: Diagnostic[] }
  | { kind: "unsolvable"; diagnostics: Diagnostic[] };

export function ok<T>(value: T, diagnostics: Diagnostic[] = []): ComputeResult<T> {
  return { kind: "ok", value, diagnostics };
}
export function fail<T>(
  kind: "incomplete-input" | "budget-exhausted" | "format-corrupt" | "unsolvable",
  diagnostics: Diagnostic[],
): ComputeResult<T> {
  return { kind, diagnostics };
}

export interface PxPoint {
  x: number;
  y: number;
}

/** 领域量：数值 + 单位 + 坐标/时间基准。 */
export interface Quantity {
  value: number;
  unit: "bp" | "px" | "ms" | "deg" | "log10bp";
  basis?: string;
}
