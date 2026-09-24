/** 统一结果类型：成功 / 预算耗尽 / 格式损坏 / 语义无解 是四种不同结果。 */
export type Diagnostic = {
  code: string;
  message: string;
  /** 出错位置：像素坐标、字节偏移或记录索引，视上下文而定 */
  position?: { x?: number; y?: number; offset?: number; index?: number };
};

export type Result<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'budget_exhausted'; spent: number; budget: number }
  | { kind: 'corrupt'; diagnostic: Diagnostic }
  | { kind: 'unsolvable'; diagnostic: Diagnostic };

export const ok = <T>(value: T): Result<T> => ({ kind: 'ok', value });
export const budgetExhausted = (spent: number, budget: number): Result<never> => ({
  kind: 'budget_exhausted', spent, budget,
});
export const corrupt = (diagnostic: Diagnostic): Result<never> => ({ kind: 'corrupt', diagnostic });
export const unsolvable = (diagnostic: Diagnostic): Result<never> => ({ kind: 'unsolvable', diagnostic });

export const isOk = <T>(r: Result<T>): r is { kind: 'ok'; value: T } => r.kind === 'ok';

/** 操作预算：每次 tick 消耗，耗尽即返回 budget_exhausted。 */
export class Budget {
  private spent = 0;
  constructor(public readonly limit: number) {}
  tick(n = 1): boolean {
    this.spent += n;
    return this.spent <= this.limit;
  }
  get used(): number { return this.spent; }
}
