import type { Diagnostic } from './types.js';

export function diag(
  code: Diagnostic['code'],
  severity: Diagnostic['severity'],
  message: string,
  at: Diagnostic['at'] = {},
): Diagnostic {
  return { code, severity, message, at };
}

export class SemanticError extends Error {
  diagnostics: Diagnostic[];
  constructor(diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('; '));
    this.diagnostics = diagnostics;
  }
}

/** 资源预算耗尽（与格式损坏、语义无解区分开） */
export class BudgetExhaustedError extends Error {
  diagnostics: Diagnostic[];
  constructor(message: string, at: Diagnostic['at'] = {}) {
    super(message);
    this.diagnostics = [diag('BUDGET_EXHAUSTED', 'error', message, at)];
  }
}

/** 格式损坏（JSON/PNG 无法解析，位置指向载荷片段） */
export class FormatCorruptError extends Error {
  diagnostics: Diagnostic[];
  constructor(message: string, at: Diagnostic['at'] = {}) {
    super(message);
    this.diagnostics = [diag('FORMAT_CORRUPT', 'error', message, at)];
  }
}
