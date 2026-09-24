import type { Diagnostic } from "./types.js";

/** 三类必须互相区分的失败结果：资源预算耗尽 / 格式损坏 / 语义无解 */
export type FailureKind =
  | "resource_exhausted"
  | "format_corrupt"
  | "semantic_impossible"
  | "incomplete_input";

export class AppError extends Error {
  readonly kind: FailureKind;
  readonly diagnostics: Diagnostic[];
  constructor(
    kind: FailureKind,
    message: string,
    diagnostics: Diagnostic[] = []
  ) {
    super(message);
    this.name = "AppError";
    this.kind = kind;
    this.diagnostics = diagnostics;
  }
}

export class ResourceExhaustedError extends AppError {
  constructor(message: string, diagnostics: Diagnostic[] = []) {
    super("resource_exhausted", message, diagnostics);
    this.name = "ResourceExhaustedError";
  }
}

export class FormatCorruptError extends AppError {
  constructor(message: string, diagnostics: Diagnostic[] = []) {
    super("format_corrupt", message, diagnostics);
    this.name = "FormatCorruptError";
  }
}

export class SemanticImpossibleError extends AppError {
  constructor(message: string, diagnostics: Diagnostic[] = []) {
    super("semantic_impossible", message, diagnostics);
    this.name = "SemanticImpossibleError";
  }
}

export class IncompleteInputError extends AppError {
  constructor(message: string, diagnostics: Diagnostic[] = []) {
    super("incomplete_input", message, diagnostics);
    this.name = "IncompleteInputError";
  }
}
