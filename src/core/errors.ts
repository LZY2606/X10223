/** 三种必须可区分的失败：资源预算耗尽 / 格式损坏 / 语义无解。 */
export type FailureKind = 'BUDGET_EXHAUSTED' | 'FORMAT_CORRUPT' | 'SEMANTIC_UNSOLVABLE';

export class DomainFailure extends Error {
  constructor(
    public readonly kind: FailureKind,
    message: string,
    public readonly detail?: unknown,
  ) {
    super(message);
    this.name = 'DomainFailure';
  }
}

export const budgetExhausted = (msg: string, detail?: unknown) =>
  new DomainFailure('BUDGET_EXHAUSTED', msg, detail);
export const formatCorrupt = (msg: string, detail?: unknown) =>
  new DomainFailure('FORMAT_CORRUPT', msg, detail);
export const semanticUnsolvable = (msg: string, detail?: unknown) =>
  new DomainFailure('SEMANTIC_UNSOLVABLE', msg, detail);
