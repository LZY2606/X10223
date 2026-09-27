/**
 * Structured diagnostics. Every failure carries a machine-readable code and a
 * position. Three failure families must never collapse into one another:
 *  - BUDGET_EXHAUSTED      resource budget ran out
 *  - FORMAT_CORRUPT        bytes / file structure unusable
 *  - SEMANTIC_UNRESOLVABLE bytes parsed, but no unique legal interpretation
 * Incomplete input is a fourth, distinct validation result.
 */

export type Severity = "error" | "warning" | "info";

export const FailureCode = {
  BudgetExhausted: "BUDGET_EXHAUSTED",
  FormatCorrupt: "FORMAT_CORRUPT",
  SemanticUnresolvable: "SEMANTIC_UNRESOLVABLE",
  IncompleteInput: "INCOMPLETE_INPUT",
  ImportInterrupted: "IMPORT_INTERRUPTED",
  NotFound: "NOT_FOUND",
} as const;
export type FailureCode = (typeof FailureCode)[keyof typeof FailureCode];

export interface PxPoint {
  x: number;
  y: number;
}

export interface CoordinateBasis {
  /** Raw image pixels are never silently replaced; canonical is a derived frame. */
  frame: "raw-image" | "canonical-image";
  origin: "top-left";
  units: "px";
  imageId: string;
  orientationId: string;
}

export type DiagnosticLocation =
  | { kind: "image-pixel"; imageId: string; point: PxPoint; basis: CoordinateBasis }
  | { kind: "field"; path: string; detail?: string }
  | { kind: "file"; name: string; offset?: number }
  | { kind: "lane"; laneId: string; point?: PxPoint }
  | { kind: "band"; bandId: string; point?: PxPoint }
  | { kind: "ladder-point"; ladderId: string; entryId: string; point?: PxPoint }
  | { kind: "segment"; segmentId: string }
  | { kind: "parameter"; name: string; versionId: string };

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  location?: DiagnosticLocation;
  related?: string[];
}

export function diag(
  code: string,
  severity: Severity,
  message: string,
  location?: DiagnosticLocation,
  related?: string[],
): Diagnostic {
  return { code, severity, message, location, related };
}

export interface Outcome<T> {
  ok: boolean;
  value?: T;
  code?: FailureCode;
  message?: string;
  diagnostics: Diagnostic[];
}

export function success<T>(value: T, diagnostics: Diagnostic[] = []): Outcome<T> {
  return { ok: true, value, diagnostics };
}

export function failure<T = never>(
  code: FailureCode,
  message: string,
  diagnostics: Diagnostic[] = [],
  partial?: T,
): Outcome<T> {
  return { ok: false, code, message, diagnostics, partial };
}

export function hasError(diagnostics: Diagnostic[]): boolean {
  return diagnostics.some((d) => d.severity === "error");
}
