// Domain quantities always carry a unit or a coordinate basis.
// Raw (un-normalized) values are kept in place; only the derived layer normalizes.
export type Quantity =
  | { unit: 'bp'; value: number }
  | { unit: 'px'; value: number; basis: 'image-pixel'; origin: 'top-left' | 'bottom-left' }
  | { unit: 'ms'; value: number }
  | { unit: string; raw: string };

export interface Diagnostic {
  code: string;
  message: string;
  position?: string; // JSON-path-like location of the offending input
  severity: 'error' | 'warning';
}

export type FailureKind = 'FORMAT_CORRUPT' | 'SEMANTIC_UNSOLVABLE' | 'BUDGET_EXHAUSTED';

export type Outcome<T> =
  | { status: 'ok'; value: T; diagnostics: Diagnostic[] }
  | { status: 'failed'; failure: FailureKind; diagnostics: Diagnostic[] };

export const ok = <T>(value: T, diagnostics: Diagnostic[] = []): Outcome<T> => ({
  status: 'ok',
  value,
  diagnostics,
});

export const failed = (failure: FailureKind, diagnostics: Diagnostic[]): Outcome<never> => ({
  status: 'failed',
  failure,
  diagnostics,
});

// Parse a raw bp quantity such as "10kb", "1500", "1.5k bp" into bp.
// Unconvertible values stay raw and produce a positioned diagnostic.
export function normalizeBp(q: Quantity, position: string): { value?: number; diagnostic?: Diagnostic } {
  if (q.unit === 'bp' && 'value' in q) {
    if (!Number.isFinite(q.value) || q.value <= 0) {
      return {
        diagnostic: { code: 'BAD_BP_VALUE', message: `non-positive or non-finite bp value`, position, severity: 'error' },
      };
    }
    return { value: q.value };
  }
  if ('raw' in q) {
    const m = q.raw.trim().match(/^([0-9]+(?:\.[0-9]+)?)\s*(k?b?p?|kb)$/i);
    if (m) {
      let v = parseFloat(m[1]);
      if (/^k/i.test(m[2])) v *= 1000;
      if (Number.isFinite(v) && v > 0) return { value: v };
    }
    return {
      diagnostic: {
        code: 'UNCONVERTIBLE_UNIT',
        message: `cannot convert raw value "${q.raw}" (unit "${q.unit}") to bp; left in place`,
        position,
        severity: 'error',
      },
    };
  }
  return {
    diagnostic: { code: 'UNCONVERTIBLE_UNIT', message: `unit "${q.unit}" is not convertible to bp`, position, severity: 'error' },
  };
}

export function px(value: number, origin: 'top-left' | 'bottom-left' = 'top-left'): Quantity {
  return { unit: 'px', value, basis: 'image-pixel', origin };
}
export function bp(value: number): Quantity {
  return { unit: 'bp', value };
}
