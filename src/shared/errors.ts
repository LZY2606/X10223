import type { Diagnostic } from './types.js';

/** 三种不同结果：资源预算耗尽 / 格式损坏 / 语义无解。 */
export class BudgetExhaustedError extends Error {
  readonly kind = 'budget-exhausted' as const;
  constructor(
    message: string,
    readonly remainingBudget: number,
    readonly diagnostics: Diagnostic[] = [],
  ) {
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

export function isDomainError(e: unknown): e is BudgetExhaustedError | FormatCorruptError | SemanticNoSolutionError {
  return (
    e instanceof BudgetExhaustedError ||
    e instanceof FormatCorruptError ||
    e instanceof SemanticNoSolutionError
  );
}
