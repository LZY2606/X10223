export type ErrorKind = 'RESOURCE_EXHAUSTED' | 'FORMAT_CORRUPTED' | 'SEMANTIC_IMPOSSIBLE';

export interface DiagnosticPosition {
  eventId?: string;
  branch?: string;
  path?: string;
  laneId?: string;
  bandId?: string;
  rungId?: string;
  pixel?: { x: number; y: number; frame: CoordinateFrame };
  blobId?: string;
}

export type CoordinateFrame = 'original-pixels' | 'capture-pixels' | 'lane-arc';

export class WorkbenchError extends Error {
  readonly kind: ErrorKind;
  readonly code: string;
  readonly position?: DiagnosticPosition;
  readonly details?: Record<string, unknown>;

  constructor(
    kind: ErrorKind,
    code: string,
    message: string,
    position?: DiagnosticPosition,
    details?: Record<string, unknown>,
  ) {
    super(message);
    this.name = 'WorkbenchError';
    this.kind = kind;
    this.code = code;
    this.position = position;
    this.details = details;
  }
}

export const exhausted = (code: string, message: string, details?: Record<string, unknown>) =>
  new WorkbenchError('RESOURCE_EXHAUSTED', code, message, undefined, details);
export const corrupted = (code: string, message: string, position?: DiagnosticPosition, details?: Record<string, unknown>) =>
  new WorkbenchError('FORMAT_CORRUPTED', code, message, position, details);
export const impossible = (code: string, message: string, position?: DiagnosticPosition, details?: Record<string, unknown>) =>
  new WorkbenchError('SEMANTIC_IMPOSSIBLE', code, message, position, details);
