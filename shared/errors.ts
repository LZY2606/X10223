/** Three distinct failure classes required by the domain spec. */
export type FailureReason = 'BUDGET_EXHAUSTED' | 'FORMAT_CORRUPT' | 'SEMANTIC_UNSOLVABLE';

export class BudgetExhaustedError extends Error {
  readonly reason: FailureReason = 'BUDGET_EXHAUSTED';
  constructor(message: string, readonly detail?: unknown) { super(message); this.name = 'BudgetExhaustedError'; }
}
export class FormatCorruptError extends Error {
  readonly reason: FailureReason = 'FORMAT_CORRUPT';
  constructor(message: string, readonly detail?: unknown) { super(message); this.name = 'FormatCorruptError'; }
}
export class SemanticUnsolvableError extends Error {
  readonly reason: FailureReason = 'SEMANTIC_UNSOLVABLE';
  constructor(message: string, readonly detail?: unknown) { super(message); this.name = 'SemanticUnsolvableError'; }
}

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  /** Machine-readable location: never silently default an incomplete input. */
  location: {
    materialId?: string;
    field?: string;
    laneIndex?: number;
    bandId?: string;
    ladderPointId?: string;
    segmentIndex?: number;
    pixel?: { x: number; y: number; basis: string };
  };
}

export function diag(code: string, severity: Diagnostic['severity'], message: string, location: Diagnostic['location']): Diagnostic {
  return { code, severity, message, location };
}
