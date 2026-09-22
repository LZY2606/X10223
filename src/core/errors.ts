import type { Diagnostic, OutcomeKind } from '../shared/types';

/** 三种必须可区分的失败结果 + 成功。 */
export class GelError extends Error {
  constructor(
    public readonly outcome: OutcomeKind,
    message: string,
    public readonly diagnostics: Diagnostic[] = []
  ) {
    super(message);
    this.name = 'GelError';
  }
}

export function budgetExhausted(message: string, diags: Diagnostic[] = []): never {
  throw new GelError('resource-budget-exhausted', message, diags);
}
export function formatCorrupt(message: string, diags: Diagnostic[] = []): never {
  throw new GelError('format-corrupt', message, diags);
}
export function semanticUnsolvable(message: string, diags: Diagnostic[] = []): never {
  throw new GelError('semantic-unsolvable', message, diags);
}

/** 输入不完整：带位置的诊断，绝不返回空值/默认值伪装成功。 */
export function incomplete(code: string, message: string, location?: Diagnostic['location']): never {
  formatCorrupt(message, [
    { code, severity: 'error', message, location, outcome: 'format-corrupt' }
  ]);
}
