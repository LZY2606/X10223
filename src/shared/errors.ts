import type { Diagnostic, OutcomeKind } from './types.js';

/**
 * 三种（实际五种）结果必须可区分：
 * - format-corrupt：字节/结构损坏（无法解析）
 * - incomplete：输入不完整（缺必需材料/观测），带位置诊断
 * - budget-exhausted：资源预算耗尽
 * - semantic-unresolvable：语义无解（如非单调标尺、重叠无法唯一决定且要求点值）
 */
export class AppError extends Error {
  readonly kind: OutcomeKind;
  readonly diagnostics: Diagnostic[];
  constructor(kind: OutcomeKind, message: string, diagnostics: Diagnostic[] = []) {
    super(message);
    this.name = 'AppError';
    this.kind = kind;
    this.diagnostics = diagnostics;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}

export function incomplete(message: string, diagnostics: Diagnostic[] = []): AppError {
  return new AppError('incomplete', message, diagnostics);
}
export function corrupt(message: string, diagnostics: Diagnostic[] = []): AppError {
  return new AppError('format-corrupt', message, diagnostics);
}
export function budget(message: string, diagnostics: Diagnostic[] = []): AppError {
  return new AppError('budget-exhausted', message, diagnostics);
}
export function unresolvable(message: string, diagnostics: Diagnostic[] = []): AppError {
  return new AppError('semantic-unresolvable', message, diagnostics);
}
