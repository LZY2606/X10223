// 诊断码与三种失败结果的构造。资源预算耗尽 / 格式损坏 / 语义无解严格分开。
import type { Diagnostic, FailureClass } from './types.js';

export const D = {
  // 格式损坏
  FORMAT_UNSUPPORTED: 'E_FORMAT_UNSUPPORTED',
  FORMAT_PNG_CORRUPT: 'E_FORMAT_PNG_CORRUPT',
  FORMAT_JSON_CORRUPT: 'E_FORMAT_JSON_CORRUPT',
  FORMAT_MISSING_FIELD: 'E_FORMAT_MISSING_FIELD',
  FORMAT_BAD_TYPE: 'E_FORMAT_BAD_TYPE',
  FORMAT_BAD_UNIT: 'E_FORMAT_BAD_UNIT',
  IMPORT_PACKAGE_TRUNCATED: 'E_IMPORT_PACKAGE_TRUNCATED',
  // 语义无解
  ORIENTATION_MISMATCH: 'E_ORIENTATION_MISMATCH',
  LADDER_NON_MONOTONIC: 'E_LADDER_NON_MONOTONIC',
  CALIBRATION_INSUFFICIENT: 'E_CALIBRATION_INSUFFICIENT',
  CALIBRATION_SEGMENT_NONMONOTONIC: 'E_CALIBRATION_SEGMENT_NONMONOTONIC',
  BAND_OUTSIDE_VALID_REGION: 'W_BAND_OUTSIDE_VALID_REGION',
  LADDER_BAND_MISSING: 'W_LADDER_BAND_MISSING',
  LADDER_UNMATCHED_BAND: 'W_LADDER_UNMATCHED_BAND',
  // 候选/区间（不是错误，但禁止唯一化）
  BAND_SATURATED: 'W_BAND_SATURATED',
  BAND_TAILING: 'W_BAND_TAILING',
  BANDS_OVERLAP: 'W_BANDS_OVERLAP',
  SMILE_DETECTED: 'W_SMILE_DETECTED',
  // 决定/修订
  REVISION_LOCAL_INVALIDATION: 'W_REVISION_LOCAL_INVALIDATION',
  DECISION_CONFLICT: 'E_DECISION_CONFLICT',
  STALE_DEPENDENCY: 'E_STALE_DEPENDENCY',
  // 预算
  BUDGET_EXHAUSTED: 'E_BUDGET_EXHAUSTED',
} as const;

export function diag(
  code: string,
  severity: Diagnostic['severity'],
  message: string,
  at?: string,
  extra?: Partial<Diagnostic>,
): Diagnostic {
  return { code, severity, message, ...(at ? { at } : {}), ...extra };
}

export function formatCorrupt(diagnostics: Diagnostic[]): {
  ok: false;
  failureClass: FailureClass;
  diagnostics: Diagnostic[];
} {
  return { ok: false, failureClass: 'format_corrupt', diagnostics };
}

export function semanticImpossible(diagnostics: Diagnostic[]): {
  ok: false;
  failureClass: FailureClass;
  diagnostics: Diagnostic[];
} {
  return { ok: false, failureClass: 'semantic_impossible', diagnostics };
}

export function budgetExhausted(diagnostics: Diagnostic[]): {
  ok: false;
  failureClass: FailureClass;
  diagnostics: Diagnostic[];
} {
  return { ok: false, failureClass: 'budget_exhausted', diagnostics };
}
