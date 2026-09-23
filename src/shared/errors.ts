import type { AppError, Diagnostic } from './types.js';

export class DomainError extends Error {
  constructor(
    public readonly kind: AppError['kind'],
    message: string,
    public readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = 'DomainError';
  }
}

export function budgetError(message: string, diagnostics: Diagnostic[] = []): DomainError {
  return new DomainError('BUDGET_EXHAUSTED', message, diagnostics);
}
export function formatError(message: string, diagnostics: Diagnostic[] = []): DomainError {
  return new DomainError('FORMAT_CORRUPT', message, diagnostics);
}
export function semanticError(message: string, diagnostics: Diagnostic[] = []): DomainError {
  return new DomainError('SEMANTIC_UNRESOLVABLE', message, diagnostics);
}
