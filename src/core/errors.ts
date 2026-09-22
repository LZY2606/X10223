import type { Diagnostic } from './types.js';

/**
 * 三种必须可区分的结果：
 *  - SemanticUnsolvableError：语义无解（如非单调标尺），输入完整但数学上无合法解。
 *  - FormatCorruptError：格式损坏（字节/结构无法解析）。
 *  - BudgetExhaustedError：资源预算耗尽（输入合法但计算超限）。
 *
 * 输入“不完整”不抛错，而是返回带位置的 Diagnostic（见 derive）。
 */

export class GelDomainError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly diagnostics: Diagnostic[] = [],
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class SemanticUnsolvableError extends GelDomainError {
  constructor(message: string, diagnostics: Diagnostic[] = []) {
    super(message, 'SEMANTIC_UNSOLVABLE', diagnostics);
  }
}

export class FormatCorruptError extends GelDomainError {
  constructor(message: string, diagnostics: Diagnostic[] = []) {
    super(message, 'FORMAT_CORRUPT', diagnostics);
  }
}

export class BudgetExhaustedError extends GelDomainError {
  constructor(usedOps: number, limitOps: number) {
    super(
      `resource budget exhausted: used ${usedOps} > limit ${limitOps}`,
      'BUDGET_EXHAUSTED',
      [
        {
          code: 'budget-exhausted',
          severity: 'error',
          message: `操作数 ${usedOps} 超过预算 ${limitOps}，计算在产生结果前中止`,
        },
      ],
    );
  }
}

export function errorKind(err: unknown): string {
  if (err instanceof SemanticUnsolvableError) return 'semantic-unsolvable';
  if (err instanceof FormatCorruptError) return 'format-corrupt';
  if (err instanceof BudgetExhaustedError) return 'budget-exhausted';
  return 'unknown';
}
