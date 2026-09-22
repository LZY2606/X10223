import type { Diagnostic, FailureClass, FailureResult } from './types.ts';

/**
 * 三类必须彼此不同的结果：
 *  - resource_budget_exhausted 资源预算耗尽（输入本身可解）
 *  - format_corrupt            格式损坏（字节/结构读不出来）
 *  - semantic_unsolvable       语义无解（结构合法但没有唯一合法答案，如非单调标尺）
 */
export class WorkflowFailure extends Error {
  readonly failureClass: FailureClass;
  readonly diagnostics: Diagnostic[];

  constructor(failureClass: FailureClass, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'WorkflowFailure';
    this.failureClass = failureClass;
    this.diagnostics = diagnostics;
  }

  toJSON(): FailureResult {
    return { failureClass: this.failureClass, message: this.message, diagnostics: this.diagnostics };
  }
}

export const resourceBudget = (message: string, diagnostics: Diagnostic[] = []) =>
  new WorkflowFailure('resource_budget_exhausted', message, diagnostics);
export const formatCorrupt = (message: string, diagnostics: Diagnostic[] = []) =>
  new WorkflowFailure('format_corrupt', message, diagnostics);
export const semanticUnsolvable = (message: string, diagnostics: Diagnostic[] = []) =>
  new WorkflowFailure('semantic_unsolvable', message, diagnostics);
