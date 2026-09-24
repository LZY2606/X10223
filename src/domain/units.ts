/** A measured quantity always carries its unit and the coordinate/time basis it was read in. */
export interface Quantity {
  value: number;
  unit: string;
  basis?: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  /** Where the problem lives, e.g. "lanes[2].bands[4].center" or "payload.exposure.unit". */
  position?: string;
}

const CONVERSIONS: Record<string, Record<string, number>> = {
  ms: { s: 0.001, min: 1 / 60000 },
  s: { ms: 1000, min: 1 / 60 },
  bp: { kbp: 0.001 },
  kbp: { bp: 1000 },
  px: {},
};

/**
 * Derived-layer normalisation. Raw representations are kept by the caller;
 * a value that cannot be converted stays in place and gets a diagnostic —
 * it is never replaced by a default just so a chart can be drawn.
 */
export function normalizeQuantity(
  q: Quantity,
  toUnit: string,
  position: string,
): { ok: true; value: number } | { ok: false; diagnostic: Diagnostic } {
  if (q.unit === toUnit) return { ok: true, value: q.value };
  const row = CONVERSIONS[q.unit];
  const factor = row?.[toUnit];
  if (factor === undefined) {
    return {
      ok: false,
      diagnostic: {
        code: 'UNIT_NOT_CONVERTIBLE',
        message: `cannot convert unit "${q.unit}" to "${toUnit}"; raw value left in place`,
        position,
      },
    };
  }
  return { ok: true, value: q.value * factor };
}
