// 资源预算耗尽、格式损坏、语义无解必须是三种不同结果（各自独立的错误类型）

export class BudgetExhaustedError extends Error {
  readonly kind = 'budget-exhausted';
  readonly code: string;
  readonly limit: number;
  readonly used: number;
  constructor(message: string, opts: { code: string; limit: number; used: number }) {
    super(message);
    this.name = 'BudgetExhaustedError';
    this.code = opts.code;
    this.limit = opts.limit;
    this.used = opts.used;
  }
}

export class FormatCorruptError extends Error {
  readonly kind = 'format-corrupt';
  readonly code: string;
  readonly offset?: number;
  constructor(message: string, opts: { code: string; offset?: number } = { code: 'FORMAT-CORRUPT' }) {
    super(message);
    this.name = 'FormatCorruptError';
    this.code = opts.code;
    if (opts.offset !== undefined) this.offset = opts.offset;
  }
}

export class SemanticUnresolvedError extends Error {
  readonly kind = 'semantic-unresolved';
  readonly code: string;
  constructor(message: string, opts: { code: string } = { code: 'SEMANTIC-UNRESOLVED' }) {
    super(message);
    this.name = 'SemanticUnresolvedError';
    this.code = opts.code;
  }
}

export class IncompleteInputError extends Error {
  readonly kind = 'incomplete-input';
  readonly code: string;
  readonly positions: import('../types.js').Diag[];
  constructor(message: string, positions: import('../types.js').Diag[], code = 'INPUT-INCOMPLETE') {
    super(message);
    this.name = 'IncompleteInputError';
    this.code = code;
    this.positions = positions;
  }
}
