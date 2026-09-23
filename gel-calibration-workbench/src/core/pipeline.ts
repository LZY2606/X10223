import type {
  Computation,
  ComputationInputRef,
  Diagnostic,
  ParamSet,
} from '../shared/types';
import { computationId, digestOf } from '../shared/canonical';

export class BudgetExhausted extends Error {
  constructor(public readonly used: number, public readonly limit: number) {
    super(`资源预算耗尽：已用 ${used} ops，上限 ${limit} ops`);
  }
}

export class Budget {
  private used = 0;
  constructor(public readonly limit: number) {}
  charge(ops: number): void {
    this.used += ops;
    if (this.used > this.limit) throw new BudgetExhausted(this.used, this.limit);
  }
  get consumed(): number {
    return this.used;
  }
}

export interface ComputationSpec<T> {
  kind: Computation['kind'];
  inputs: ComputationInputRef[];
  parents: string[];
  params: ParamSet;
  seq: number;
  // 实际计算体；通过 budget.charge 申报操作量
  run: (budget: Budget) => { result: T; diagnostics: Diagnostic[] };
}

// 统一的计算执行器：记录输入摘要、参数版本、父级依赖；
// 资源预算耗尽是独立失败类别，不与语义错误混淆。
export function runComputation<T>(spec: ComputationSpec<T>): Computation {
  const inputDigest = digestOf({
    kind: spec.kind,
    inputs: spec.inputs,
    parents: [...spec.parents].sort(),
    paramVersion: spec.params.version,
    interpolation: spec.params.interpolation,
    saturationThreshold: spec.params.saturationThreshold,
    overlapResolutionPx: spec.params.overlapResolutionPx,
  });
  const id = computationId(spec.kind, inputDigest);
  const budget = new Budget(spec.params.budgetOps);
  try {
    const { result, diagnostics } = budget.limit <= 0 ? (() => { throw new BudgetExhausted(1, 0); })() : spec.run(budget);
    const hasError = diagnostics.some((d) => d.severity === 'error');
    return {
      id,
      kind: spec.kind,
      paramVersion: spec.params.version,
      inputDigest,
      inputs: spec.inputs,
      parents: spec.parents,
      status: hasError || diagnostics.length > 0 ? 'diagnostic' : 'ok',
      failureKind: null,
      result,
      diagnostics,
      budgetUsed: budget.consumed,
      seq: spec.seq,
    };
  } catch (err) {
    if (err instanceof BudgetExhausted) {
      return {
        id,
        kind: spec.kind,
        paramVersion: spec.params.version,
        inputDigest,
        inputs: spec.inputs,
        parents: spec.parents,
        status: 'failed',
        failureKind: 'RESOURCE_BUDGET_EXHAUSTED',
        result: null,
        diagnostics: [
          {
            code: 'RESOURCE_BUDGET_EXHAUSTED',
            severity: 'error',
            location: { entity: 'computation', id },
            message: err.message,
          },
        ],
        budgetUsed: err.used,
        seq: spec.seq,
      };
    }
    throw err;
  }
}
