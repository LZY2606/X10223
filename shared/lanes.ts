import { PxPoint, PxRegion } from './units.js';
import { Ruler } from './calibration.js';

/**
 * Lane geometry. A lane is a centerline polyline in image-px; lanes may be bent
 * and the gel may "smile": bands of equal MW form a curve, so the same pixel
 * height in two lanes is NOT the same molecular weight.
 */

export interface LaneCurve {
  laneId: string;
  imageId: string;
  /** centerline polyline, ordered from wells (top) to front (bottom) */
  centerline: PxPoint[];
  /** half-width of the lane in px */
  halfWidth: number;
}

/** quadratic smile front: extra migration offset (px) at horizontal position x */
export interface SmileModel {
  a: number; // amplitude in px
  cx: number; // center x of the gel
  w: number; // half-width normalization
}

export function smileOffset(smile: SmileModel, x: number): number {
  const t = (x - smile.cx) / smile.w;
  return smile.a * t * t;
}

/** y of the lane centerline at horizontal position x (piecewise linear). */
export function centerlineYAt(curve: LaneCurve, x: number): number {
  const pts = curve.centerline;
  if (pts.length === 0) return 0;
  if (x <= pts[0]!.x) return pts[0]!.y;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (x <= b.x) {
      const t = (x - a.x) / (b.x - a.x || 1);
      return a.y + t * (b.y - a.y);
    }
  }
  return pts[pts.length - 1]!.y;
}

/** x of the lane centerline at vertical position y (piecewise linear). */
export function centerlineXAt(curve: LaneCurve, y: number): number {
  const pts = curve.centerline;
  if (pts.length === 0) return 0;
  if (y <= pts[0]!.y) return pts[0]!.x;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1]!;
    const b = pts[i]!;
    if (y <= b.y) {
      const t = (y - a.y) / (b.y - a.y || 1);
      return a.x + t * (b.x - a.x);
    }
  }
  return pts[pts.length - 1]!.x;
}

/**
 * Smile-corrected migration coordinate s for a band at pixel (x, y) in a lane.
 * s removes the smile offset so equal s means equal MW across lanes.
 */
export function correctedS(y: number, x: number, smile: SmileModel): number {
  return y - smileOffset(smile, x);
}

/**
 * Local ruler for a lane: the ladder ruler translated into this lane's pixel
 * space. The valid region is shifted by the smile difference between the lane
 * and the ladder lane — outside it, no point estimates are allowed.
 */
export function localValidRegion(
  ruler: Ruler,
  laneX: number,
  ladderX: number,
  smile: SmileModel,
): PxRegion {
  const shift = smileOffset(smile, laneX) - smileOffset(smile, ladderX);
  return {
    yMin: ruler.validRegion.yMin + shift,
    yMax: ruler.validRegion.yMax + shift,
    space: 'image-px',
    imageId: ruler.imageId,
    laneId: ruler.laneId,
  };
}

/** mean absolute deviation of a centerline from a straight vertical line (px) */
export function laneCurvature(curve: LaneCurve): number {
  const xs = curve.centerline.map((p) => p.x);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  return xs.reduce((a, x) => a + Math.abs(x - mean), 0) / xs.length;
}
