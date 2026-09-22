// 资源预算耗尽、格式损坏、语义无解——三种截然不同的结果。
import type { Diagnostic } from './types.ts';

export type GelErrorCode =
  | 'BUDGET_EXHAUSTED'
  | 'CORRUPT_FORMAT'
  | 'SEMANTICALLY_UNSOLVABLE'
  | 'INCOMPLETE_INPUT';

export class GelError extends Error {
  code: GelErrorCode;
  diagnostics: Diagnostic[];
  constructor(code: GelErrorCode, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'GelError';
    this.code = code;
    this.diagnostics = diagnostics;
  }
}

export function budgetExhausted(message: string, used: number, budget: number): GelError {
  return new GelError('BUDGET_EXHAUSTED', message, [
    { code: 'BUDGET_EXHAUSTED', severity: 'error', message: `${message} (used=${used}, budget=${budget})` }
  ]);
}

export function corruptFormat(message: string, byteOffset?: number, field?: string): GelError {
  return new GelError('CORRUPT_FORMAT', message, [
    { code: 'CORRUPT_FORMAT', severity: 'error', message, position: { byteOffset, field } }
  ]);
}

export function semanticallyUnsolvable(message: string, diagnostics: Diagnostic[] = []): GelError {
  return new GelError('SEMANTICALLY_UNSOLVABLE', message, diagnostics);
}

export function incompleteInput(diagnostics: Diagnostic[]): GelError {
  return new GelError('INCOMPLETE_INPUT', 'input is incomplete; no defaults were substituted', diagnostics);
}
