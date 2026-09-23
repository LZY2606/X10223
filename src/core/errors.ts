import type { Diagnostic } from '../shared/types.js';

/**
 * 资源预算耗尽、格式损坏、语义无解是三种互不相同的结果，
 * 分别用独立异常类型表达，测试可直接区分。
 */
export class BudgetExhaustedError extends Error {
  readonly kind = 'budget-exhausted' as const;
  constructor(message: string, readonly diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'BudgetExhaustedError';
  }
}

export class FormatCorruptError extends Error {
  readonly kind = 'format-corrupt' as const;
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = 'FormatCorruptError';
  }
}

export class SemanticNoSolutionError extends Error {
  readonly kind = 'semantic-no-solution' as const;
  constructor(
    message: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = 'SemanticNoSolutionError';
  }
}

export type AppError = BudgetExhaustedError | FormatCorruptError | SemanticNoSolutionError;

export function isAppError(e: unknown): e is AppError {
  return e instanceof BudgetExhaustedError || e instanceof FormatCorruptError || e instanceof SemanticNoSolutionError;
}
