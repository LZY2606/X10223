export class IncompleteInputError extends Error {
  readonly kind = 'incomplete-input' as const;
  constructor(
    message: string,
    readonly path: string,
    readonly position?: { x?: number; y?: number; laneId?: string; bandId?: string }
  ) {
    super(message);
    this.name = 'IncompleteInputError';
  }
}

export class FormatCorruptError extends Error {
  readonly kind = 'format-corrupt' as const;
  constructor(
    message: string,
    readonly path: string
  ) {
    super(message);
    this.name = 'FormatCorruptError';
  }
}

export class SemanticImpossibleError extends Error {
  readonly kind = 'semantic-impossible' as const;
  constructor(
    message: string,
    readonly diagnostics: unknown[]
  ) {
    super(message);
    this.name = 'SemanticImpossibleError';
  }
}

export class ResourceExhaustedError extends Error {
  readonly kind = 'resource-exhausted' as const;
  constructor(message: string) {
    super(message);
    this.name = 'ResourceExhaustedError';
  }
}

export function classifyFailure(error: unknown): 'incomplete' | 'corrupt' | 'impossible' | 'exhausted' | 'unknown' {
  if (error instanceof IncompleteInputError) return 'incomplete';
  if (error instanceof FormatCorruptError) return 'corrupt';
  if (error instanceof SemanticImpossibleError) return 'impossible';
  if (error instanceof ResourceExhaustedError) return 'exhausted';
  return 'unknown';
}
