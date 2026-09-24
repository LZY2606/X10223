import type { Diagnostic } from './units';

/** Three failure results that must stay distinguishable. */
export type FailureKind = 'ResourceBudgetExhausted' | 'FormatCorrupt' | 'SemanticUnsolvable';

export interface Failure {
  kind: FailureKind;
  detail: string;
}

export type Outcome<T> =
  | { ok: true; value: T; diagnostics: Diagnostic[] }
  | { ok: false; failure: Failure; diagnostics: Diagnostic[] };

export function ok<T>(value: T, diagnostics: Diagnostic[] = []): Outcome<T> {
  return { ok: true, value, diagnostics };
}

export function fail<T>(kind: FailureKind, detail: string, diagnostics: Diagnostic[] = []): Outcome<T> {
  return { ok: false, failure: { kind, detail }, diagnostics };
}
