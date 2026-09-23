// 三种失败必须是不同结果：资源预算耗尽 / 格式损坏 / 语义无解。
import type { Diagnostic } from './types.js';

export type FailureKind = 'BUDGET_EXHAUSTED' | 'FORMAT_CORRUPT' | 'NO_SOLUTION';

export class AppError extends Error {
  readonly kind: FailureKind;
  readonly diagnoses: Diagnostic[];
  readonly retriable: boolean;
  constructor(
    kind: FailureKind,
    message: string,
    diagnoses: Diagnostic[] = [],
    retriable = false
  ) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.diagnoses = diagnoses;
    this.retriable = retriable;
  }
}

export class BudgetExhaustedError extends AppError {
  constructor(message: string, diagnoses: Diagnostic[] = []) {
    super('BUDGET_EXHAUSTED', message, diagnoses, true);
    this.name = 'BudgetExhaustedError';
  }
}

export class FormatCorruptError extends AppError {
  constructor(message: string, diagnoses: Diagnostic[] = []) {
    super('FORMAT_CORRUPT', message, diagnoses, false);
    this.name = 'FormatCorruptError';
  }
}

export class NoSolutionError extends AppError {
  constructor(message: string, diagnoses: Diagnostic[] = []) {
    super('NO_SOLUTION', message, diagnoses, false);
    this.name = 'NoSolutionError';
  }
}
