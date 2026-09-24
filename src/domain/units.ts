/** Domain quantities always carry a unit or a coordinate basis.
 *  Raw representations are preserved at import; normalization happens only
 *  in the derived layer. Values that cannot be converted stay in place and
 *  get a positioned diagnostic instead of being silently dropped. */

export type Unit = 'px' | 'bp' | 'log10(bp)' | 'ms' | 'count' | 'ratio';

export interface Quantity {
  value: number;
  unit: Unit;
}

export interface CoordBasis {
  space: 'image';
  origin: 'top-left';
  axis_x: 'right';
  axis_y: 'down';
  unit: 'px';
  migration: '+y';
}

export const IMAGE_BASIS: CoordBasis = {
  space: 'image',
  origin: 'top-left',
  axis_x: 'right',
  axis_y: 'down',
  unit: 'px',
  migration: '+y',
};

export interface PixelPoint {
  x: number;
  y: number;
  basis: CoordBasis;
}

export interface Diagnostic {
  path: string;
  code: string;
  message: string;
}

export function diag(path: string, code: string, message: string): Diagnostic {
  return { path, code, message };
}

export interface Conversion<T> {
  value?: T;
  diagnostics: Diagnostic[];
}

const UNIT_ALIASES: Record<string, Unit> = {
  px: 'px', pixel: 'px', pixels: 'px',
  bp: 'bp', basepair: 'bp', basepairs: 'bp',
  'log10(bp)': 'log10(bp)',
  ms: 'ms', millisecond: 'ms',
  count: 'count', counts: 'count',
  ratio: 'ratio',
};

/** Normalize a raw quantity like {value, unit} or a bare number with an
 *  assumed unit. Never fabricates: failures return diagnostics with path. */
export function normalizeQuantity(raw: unknown, path: string, assumed?: Unit): Conversion<Quantity> {
  const diagnostics: Diagnostic[] = [];
  if (typeof raw === 'number' && Number.isFinite(raw)) {
    if (!assumed) {
      diagnostics.push(diag(path, 'UNIT_MISSING', 'bare number without unit and no assumed unit'));
      return { diagnostics };
    }
    return { value: { value: raw, unit: assumed }, diagnostics };
  }
  if (raw && typeof raw === 'object') {
    const obj = raw as Record<string, unknown>;
    const v = obj.value;
    const u = obj.unit;
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      diagnostics.push(diag(`${path}.value`, 'VALUE_NOT_NUMERIC', `value is not a finite number: ${JSON.stringify(v)}`));
      return { diagnostics };
    }
    if (typeof u !== 'string' || !(u in UNIT_ALIASES)) {
      diagnostics.push(diag(`${path}.unit`, 'UNIT_UNKNOWN', `unit not convertible: ${JSON.stringify(u)}`));
      return { diagnostics };
    }
    return { value: { value: v, unit: UNIT_ALIASES[u] }, diagnostics };
  }
  diagnostics.push(diag(path, 'QUANTITY_MALFORMED', `cannot interpret quantity: ${JSON.stringify(raw)}`));
  return { diagnostics };
}

export function normalizePixelPoint(raw: unknown, path: string): Conversion<PixelPoint> {
  const diagnostics: Diagnostic[] = [];
  if (!raw || typeof raw !== 'object') {
    diagnostics.push(diag(path, 'POINT_MALFORMED', `cannot interpret pixel point: ${JSON.stringify(raw)}`));
    return { diagnostics };
  }
  const obj = raw as Record<string, unknown>;
  if (typeof obj.x !== 'number' || typeof obj.y !== 'number') {
    diagnostics.push(diag(path, 'POINT_COORDS_MISSING', 'pixel point requires numeric x and y'));
    return { diagnostics };
  }
  return { value: { x: obj.x, y: obj.y, basis: IMAGE_BASIS }, diagnostics };
}
