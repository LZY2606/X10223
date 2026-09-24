/**
 * 三类必须可区分的失败，以及“输入不完整 -> 带位置诊断”。
 * 不允许用 null/默认值伪装成功：所有路径都落在 Diagnostic 或具名错误里。
 */
export type DiagnosticCode =
  | 'INCOMPLETE_INPUT'
  | 'FORMAT_CORRUPT'
  | 'RESOURCE_BUDGET'
  | 'SEMANTIC_UNRESOLVABLE'
  | 'UNIT_UNCONVERTIBLE'
  | 'IMAGE_OUT_OF_FRAME'
  | 'LADDER_MISSING_BAND'
  | 'CALIBRATION_NONMONOTONIC'
  | 'CALIBRATION_OUT_OF_RANGE'
  | 'BAND_SATURATED'
  | 'BAND_OVERLAP'
  | 'BAND_SMEAR'
  | 'LANE_CURVE_VALIDITY'
  | 'CONFLICT_UNRESOLVED'
  | 'REVISION_LOCALIZED_INVALIDATION';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: 'error' | 'warning' | 'info';
  /** 机器可定位：JSON Pointer（输入片段）或稳定对象身份（受影响对象）。 */
  path: string;
  message: string;
  /** 受影响对象的稳定身份（片段/候选/分子量值）。 */
  affects?: string[];
}

export class DomainError extends Error {
  constructor(
    public readonly code: DiagnosticCode,
    message: string,
    public readonly diagnostics: Diagnostic[] = []
  ) {
    super(message);
    this.name = new.target.name;
  }
}
export class FormatCorruptError extends DomainError {}
export class ResourceBudgetError extends DomainError {}
export class SemanticUnresolvableError extends DomainError {}

export function diag(
  code: DiagnosticCode,
  path: string,
  message: string,
  severity: Diagnostic['severity'] = 'error',
  affects?: string[]
): Diagnostic {
  return { code, severity, path, message, affects };
}
