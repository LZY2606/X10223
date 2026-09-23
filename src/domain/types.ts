// 统一的结果/诊断类型：资源预算耗尽、格式损坏、语义无解是三种不同结果。
export type FailureKind = 'BUDGET_EXHAUSTED' | 'FORMAT_CORRUPT' | 'SEMANTIC_UNSOLVABLE';

export interface DiagnosticPosition {
  materialId?: string;
  laneId?: string;
  bandId?: string;
  segmentId?: string;
  pointId?: string;
  xPx?: number;
  yPx?: number;
  sPx?: number;
}

export interface Diagnostic {
  code: string;
  message: string;
  position?: DiagnosticPosition;
}

export type Result<T> =
  | { ok: true; value: T; diagnostics?: Diagnostic[] }
  | { ok: false; kind: FailureKind; diagnostics: Diagnostic[] };

export const ok = <T>(value: T, diagnostics?: Diagnostic[]): Result<T> => ({ ok: true, value, diagnostics });
export const fail = <T>(kind: FailureKind, diagnostics: Diagnostic[]): Result<T> => ({ ok: false, kind, diagnostics });

// 领域量永远携带单位或坐标基准。
export type Unit = 'bp' | 'px' | 'ms' | 'log10bp' | 's_px';
export interface Quantity { value: number; unit: Unit }
