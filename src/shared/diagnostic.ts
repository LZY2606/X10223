/**
 * 诊断（带位置）。输入不完整时绝不返回空值/默认值伪装成功，
 * 而是返回带位置的诊断。
 */
export type Severity = 'error' | 'warning' | 'info';

export type DiagnosticKind =
  | 'incomplete-input'
  | 'unconvertible-unit'
  | 'non-monotonic-calibration'
  | 'missing-ladder-band'
  | 'saturated-band'
  | 'overlapping-bands'
  | 'tailed-band'
  | 'outside-valid-region'
  | 'curved-lane-requires-local-scale'
  | 'conflicting-decisions'
  | 'orientation-mismatch'
  | 'rejected-candidate';

export interface Diagnostic {
  code: DiagnosticKind;
  severity: Severity;
  message: string;
  /** 机器可定位：材料/对象身份 + 像素位置（原图坐标系）。 */
  location?: {
    materialId?: string;
    laneId?: string;
    bandId?: string;
    segmentId?: string;
    x?: number;
    y?: number;
  };
}

/** 三种不同结果：资源预算耗尽 / 格式损坏 / 语义无解。 */
export class BudgetExhaustedError extends Error {
  readonly code = 'BUDGET_EXHAUSTED';
  constructor(message: string, readonly budget?: { name: string; limit: number; used: number }) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

export class CorruptFormatError extends Error {
  readonly code = 'CORRUPT_FORMAT';
  constructor(message: string, readonly detail?: unknown) {
    super(message);
    this.name = 'CorruptFormatError';
  }
}

export class SemanticUnresolvableError extends Error {
  readonly code = 'SEMANTIC_UNRESOLVABLE';
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = 'SemanticUnresolvableError';
  }
}
