import type { Diagnostic, DiagnosticKind } from './types';

export function diag(
  code: string,
  kind: DiagnosticKind,
  message: string,
  location?: Diagnostic['location']
): Diagnostic {
  return { code, kind, message, ...(location ? { location } : {}) };
}

// 三类失败必须彼此可区分
export class IncompleteInputError extends Error {
  readonly kind = 'incomplete-input' as const;
  constructor(public diagnostics: Diagnostic[]) {
    super('incomplete input');
  }
}
export class CorruptFormatError extends Error {
  readonly kind = 'corrupt-format' as const;
  constructor(public diagnostics: Diagnostic[]) {
    super('corrupt format');
  }
}
export class SemanticImpossibleError extends Error {
  readonly kind = 'semantic-impossible' as const;
  constructor(public diagnostics: Diagnostic[]) {
    super('semantic impossibility');
  }
}
export class BudgetExhaustedError extends Error {
  readonly kind = 'budget-exhausted' as const;
  constructor(public diagnostics: Diagnostic[]) {
    super('budget exhausted');
  }
}
