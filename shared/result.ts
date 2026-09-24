/** Positioned diagnostic: never fake success with null/defaults when input is incomplete. */
export interface Diagnostic {
  code: string;
  message: string;
  at?: {
    materialId?: string;
    laneId?: string;
    bandIndex?: number;
    y?: number;
    path?: string;
  };
}

/**
 * Every computation returns one of four distinct outcomes.
 * resource-exhausted / corrupt / unsolvable are three DIFFERENT failure kinds.
 */
export type Outcome<T> =
  | { kind: 'ok'; value: T; diagnostics: Diagnostic[] }
  | { kind: 'resource-exhausted'; diagnostic: Diagnostic }
  | { kind: 'corrupt'; diagnostic: Diagnostic }
  | { kind: 'unsolvable'; diagnostic: Diagnostic };

export function ok<T>(value: T, diagnostics: Diagnostic[] = []): Outcome<T> {
  return { kind: 'ok', value, diagnostics };
}
export function resourceExhausted<T>(diagnostic: Diagnostic): Outcome<T> {
  return { kind: 'resource-exhausted', diagnostic };
}
export function corrupt<T>(diagnostic: Diagnostic): Outcome<T> {
  return { kind: 'corrupt', diagnostic };
}
export function unsolvable<T>(diagnostic: Diagnostic): Outcome<T> {
  return { kind: 'unsolvable', diagnostic };
}
export function isOk<T>(o: Outcome<T>): o is { kind: 'ok'; value: T; diagnostics: Diagnostic[] } {
  return o.kind === 'ok';
}
