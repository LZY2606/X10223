export type FailureKind = "budget_exhausted" | "format_corrupt" | "semantic_unsolvable";

export interface Diagnostic {
  code: string;
  message: string;
  /** JSON-pointer-ish location of the offending input fragment, e.g. /ladders/0/sizes/3 */
  path: string;
  severity: "error" | "warning";
}

export type Result<T> =
  | { ok: true; value: T; diagnostics: Diagnostic[] }
  | { ok: false; kind: FailureKind; diagnostics: Diagnostic[] };

export function ok<T>(value: T, diagnostics: Diagnostic[] = []): Result<T> {
  return { ok: true, value, diagnostics };
}
export function fail<T>(kind: FailureKind, diagnostics: Diagnostic[]): Result<T> {
  return { ok: false, kind, diagnostics };
}
export function diag(code: string, message: string, path: string, severity: "error" | "warning" = "error"): Diagnostic {
  return { code, message, path, severity };
}
