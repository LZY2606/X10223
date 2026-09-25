export type Severity = 'info' | 'warning' | 'error';

export type LocationRef =
  | { kind: 'image'; imageId: string; x?: number; y?: number; frame?: string }
  | { kind: 'lane'; laneId: string; s?: number; x?: number; y?: number; frame?: string }
  | { kind: 'band'; bandId: string }
  | { kind: 'ladder'; ladderId: string; nominalBandId?: string }
  | { kind: 'event'; eventId: string }
  | { kind: 'parameter'; parameter: string }
  | { kind: 'bundle'; path?: string };

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  location?: LocationRef;
  hint?: string;
}

export function diagnostic(
  code: string,
  message: string,
  severity: Severity = 'error',
  location?: LocationRef,
  hint?: string,
): Diagnostic {
  return { code, message, severity, location, hint };
}
