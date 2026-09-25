import type { Diagnostic } from './diagnostics.js';

export type FailureKind =
  | 'RESOURCE_BUDGET_EXHAUSTED'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNRESOLVED';

export class DomainFailure extends Error {
  readonly kind: FailureKind;
  readonly diagnostics: Diagnostic[];
  readonly context?: Record<string, unknown>;

  constructor(kind: FailureKind, message: string, diagnostics: Diagnostic[] = [], context?: Record<string, unknown>) {
    super(message);
    this.name = 'DomainFailure';
    this.kind = kind;
    this.diagnostics = diagnostics;
    this.context = context;
  }
}

export function isDomainFailure(e: unknown): e is DomainFailure {
  return e instanceof DomainFailure;
}
