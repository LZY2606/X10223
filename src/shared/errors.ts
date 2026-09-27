/** Three distinguishable failure outcomes. Never collapse them into one generic error. */
export type FailureCode = 'BUDGET_EXHAUSTED' | 'FORMAT_CORRUPT' | 'SEMANTIC_UNSOLVABLE';

export class AnalysisFailure extends Error {
  constructor(
    public readonly code: FailureCode,
    message: string,
    public readonly position?: { x?: number; y?: number; laneId?: string },
  ) {
    super(message);
    this.name = 'AnalysisFailure';
  }
}

export const budgetExhausted = (msg: string) => new AnalysisFailure('BUDGET_EXHAUSTED', msg);
export const formatCorrupt = (msg: string) => new AnalysisFailure('FORMAT_CORRUPT', msg);
export const semanticUnsolvable = (msg: string, position?: { x?: number; y?: number; laneId?: string }) =>
  new AnalysisFailure('SEMANTIC_UNSOLVABLE', msg, position);

export interface FailureResult {
  ok: false;
  failure: { code: FailureCode; message: string; position?: { x?: number; y?: number; laneId?: string } };
}

export function toFailureResult(err: unknown): FailureResult {
  if (err instanceof AnalysisFailure) {
    return { ok: false, failure: { code: err.code, message: err.message, position: err.position } };
  }
  // Unknown errors are reported as format-corrupt only at decode boundaries; otherwise rethrow.
  throw err;
}
