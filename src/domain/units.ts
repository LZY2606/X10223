/** Every domain quantity carries a unit and a coordinate/time basis.
 *  `raw` preserves the original imported representation; normalization happens only in the derived layer. */
export type Unit = 'px' | 'bp' | 'ms' | 'deg' | 'gray';

export interface Qty<U extends Unit = Unit> {
  value: number;
  unit: U;
  basis: string;
  raw?: string;
}

export function qty<U extends Unit>(value: number, unit: U, basis: string, raw?: string): Qty<U> {
  const q: Qty<U> = { value, unit, basis };
  if (raw !== undefined) q.raw = raw;
  return q;
}

export interface Position {
  lane?: string;
  band?: number | string;
  xPx?: number;
  yPx?: number;
}

export interface Diagnostic {
  code: string;
  message: string;
  severity: 'error' | 'warning';
  position?: Position;
}

export function diag(code: string, message: string, severity: 'error' | 'warning', position?: Position): Diagnostic {
  const d: Diagnostic = { code, message, severity };
  if (position) d.position = position;
  return d;
}
