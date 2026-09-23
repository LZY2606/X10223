import type { Diagnostic } from './types.js';

export class DomainError extends Error {
  constructor(
    message: string,
    readonly code: Diagnostic['code'],
    readonly path: string,
    readonly position?: Diagnostic['position']
  ) {
    super(message);
    this.name = new.target.name;
  }
}

export class FormatCorruptError extends DomainError {
  constructor(message: string, path = '$', position?: Diagnostic['position']) {
    super(message, 'FORMAT_CORRUPT', path, position);
  }
}

export class SemanticUnresolvableError extends DomainError {
  constructor(message: string, path = '$', position?: Diagnostic['position']) {
    super(message, 'SEMANTIC_UNRESOLVABLE', path, position);
  }
}

export class ResourceExhaustedError extends DomainError {
  constructor(message: string, path = '$') {
    super(message, 'RESOURCE_EXHAUSTED', path);
  }
}

export class IncompleteInputDiagnostics extends Error {
  constructor(readonly diagnostics: Diagnostic[]) {
    super('Input is incomplete');
    this.name = 'IncompleteInputDiagnostics';
  }
}
