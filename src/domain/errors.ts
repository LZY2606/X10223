import type { Diagnostic, ResourceBudget } from "../shared/types.js";

export class AppError extends Error {
  constructor(
    public readonly outcome: "format-error" | "semantic-error" | "budget" | "incomplete",
    public readonly diagnostics: Diagnostic[],
    message?: string
  ) {
    super(message ?? outcome);
    this.name = "AppError";
  }
}

export function formatError(path: string, message: string): AppError {
  return new AppError("format-error", [
    { code: "FORMAT_CORRUPT", severity: "error", path, message }
  ]);
}

export function semanticError(path: string, message: string): AppError {
  return new AppError("semantic-error", [
    { code: "SEMANTIC_PROJECT_INCONSISTENT", severity: "error", path, message }
  ]);
}

export function budgetError(path: string, budget: ResourceBudget, used: string): AppError {
  return new AppError("budget", [
    {
      code: "RESOURCE_BUDGET",
      severity: "error",
      path,
      message: `资源预算耗尽：${used} 超过预算 ${JSON.stringify(budget)}`
    }
  ]);
}
