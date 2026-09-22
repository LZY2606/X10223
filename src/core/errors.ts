import type { Diagnostic, Failure, FailureKind } from '../shared/types';

export class GelFailure extends Error {
  readonly failure: Failure;
  constructor(kind: FailureKind, diagnostics: Diagnostic[]) {
    super(diagnostics[0]?.message ?? kind);
    this.name = 'GelFailure';
    this.failure = { kind, diagnostics };
  }
}

export function diag(
  code: Diagnostic['code'],
  severity: Diagnostic['severity'],
  message: string,
  position: Diagnostic['position'] = {}
): Diagnostic {
  return { code, severity, message, position };
}
