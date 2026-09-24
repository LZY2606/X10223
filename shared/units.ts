/** Domain quantities always carry a unit or a coordinate basis. */
export type Unit = 'bp' | 'kDa' | 'px' | 'ms' | 'raw';

export interface Quantity {
  value: number;
  unit: Unit;
}

/** Pixel-level source: every position is anchored to a specific image. */
export interface PxPoint {
  x: number;
  y: number;
  space: 'image-px';
  imageId: string;
}

export interface PxRegion {
  yMin: number;
  yMax: number;
  space: 'image-px';
  imageId: string;
  laneId: string;
}

/** Raw representation exactly as imported; normalization happens in the derived layer. */
export interface RawQuantity {
  raw: string;
}

const UNIT_RE = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(kb|kda|bp|da)\s*$/i;

/**
 * Parse a raw ladder nominal string into a normalized quantity.
 * Unconvertible values stay raw at their original position (caller attaches a diagnostic).
 */
export function parseNominal(raw: string): Quantity | null {
  const m = UNIT_RE.exec(raw);
  if (!m) return null;
  const n = parseFloat(m[1]!);
  const u = m[2]!.toLowerCase();
  if (u === 'kb') return { value: n * 1000, unit: 'bp' };
  if (u === 'bp') return { value: n, unit: 'bp' };
  if (u === 'kda') return { value: n, unit: 'kDa' };
  if (u === 'da') return { value: n / 1000, unit: 'kDa' };
  return null;
}

export function formatQuantity(q: Quantity): string {
  return `${q.value} ${q.unit}`;
}
