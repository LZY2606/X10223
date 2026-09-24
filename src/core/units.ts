/**
 * Quantities and coordinate frames.
 *
 * Every domain value carries its unit or coordinate datum. Import preserves the
 * raw representation; normalisation happens only in the derived layer. Values
 * that cannot be converted stay in place with a diagnostic instead of being
 * dropped for the sake of plotting.
 */

export type MassUnit = 'bp';
export type LengthUnit = 'pixel' | 'millimeter';
export type TimeUnit = 'millisecond';

/** A physical-ish quantity that always travels with its unit. */
export interface Quantity<V = number> {
  value: V;
  unit: string;
  /** Raw token as received on import, preserved verbatim. */
  raw?: string;
}

export function massBp(value: number, raw?: string): Quantity {
  return { value, unit: 'bp', raw };
}

export function px(value: number): Quantity {
  return { value, unit: 'pixel' };
}

/**
 * Coordinate frames. Pixel provenance always records which frame the numbers
 * are in so a rotation never silently moves provenance.
 *
 * - 'raw': the pixel grid of the stored image bytes.
 * - 'upright': image pixels after applying the declared capture orientation.
 *   Lane curves and band centres used by the algorithms live here.
 */
export type FrameId = 'raw' | 'upright';

export interface PixelPoint {
  x: number;
  y: number;
  frame: FrameId;
  /** Sequence number of the image material this point references. */
  imageSeq: number;
  /** Human/audit provenance note, e.g. "auto detector v1" or a reviewer. */
  source: string;
}

export function point(x: number, y: number, imageSeq: number, source: string, frame: FrameId = 'upright'): PixelPoint {
  return { x, y, frame, imageSeq, source };
}

/** Linear transform between frames, stored as an audit-able formula. */
export interface FrameTransform {
  from: FrameId;
  to: FrameId;
  /** Clockwise rotation in degrees, applied about the image centre. */
  rotationDeg: 0 | 90 | 180 | 270;
  srcWidthPx: number;
  srcHeightPx: number;
}

export function applyTransform(p: PixelPoint, t: FrameTransform): PixelPoint {
  if (t.from === t.to || t.rotationDeg === 0) {
    return { ...p, frame: t.to };
  }
  const w = t.srcWidthPx;
  const h = t.srcHeightPx;
  // Clockwise rotation about centre.
  const c = Math.cos((-t.rotationDeg * Math.PI) / 180);
  const s = Math.sin((-t.rotationDeg * Math.PI) / 180);
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  let nx = c * dx - s * dy;
  let ny = s * dx + c * dy;
  let ow = w;
  let oh = h;
  if (t.rotationDeg === 90 || t.rotationDeg === 270) {
    ow = h;
    oh = w;
  }
  nx += (ow - 1) / 2;
  ny += (oh - 1) / 2;
  return { x: nx, y: ny, frame: t.to, imageSeq: p.imageSeq, source: p.source };
}
