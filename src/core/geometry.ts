/**
 * Lane geometry: polyline resampling by arc length.
 *
 * The crucial fact this module protects: on a smiling gel, equal pixel height
 * does not mean equal migration distance. Every downstream algorithm asks for
 * points by arc length `s`, never by image y.
 */
import type { PixelPoint } from './units.js';
import { digestOf, derivedId } from './identity.js';
import type {
  LaneBoundaryMaterial,
  LaneGeometryResult,
  ParamSet,
} from './domain.js';

export function polylineLength(points: PixelPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return total;
}

/** Point at arc length s along a polyline (clamped at ends). */
export function pointAtArc(points: PixelPoint[], s: number): PixelPoint {
  if (points.length === 0) throw new Error('empty polyline');
  if (points.length === 1) return { ...points[0] };
  let remaining = s;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (remaining <= seg || i === points.length - 1) {
      const f = seg === 0 ? 0 : Math.max(0, Math.min(1, remaining / seg));
      return {
        x: a.x + (b.x - a.x) * f,
        y: a.y + (b.y - a.y) * f,
        frame: a.frame,
        imageSeq: a.imageSeq,
        source: a.source,
      };
    }
    remaining -= seg;
  }
  return { ...points[points.length - 1] };
}

/** Resample a polyline at evenly spaced arc lengths. */
export function resampleByArc(points: PixelPoint[], count: number): { points: PixelPoint[]; arcLengths: number[] } {
  const total = polylineLength(points);
  const out: PixelPoint[] = [];
  const arcs: number[] = [];
  for (let i = 0; i < count; i++) {
    const s = total === 0 ? 0 : (i / (count - 1)) * total;
    arcs.push(s);
    out.push(pointAtArc(points, s));
  }
  return { points: out, arcLengths: arcs };
}

function midpoint(a: PixelPoint, b: PixelPoint): PixelPoint {
  return {
    x: (a.x + b.x) / 2,
    y: (a.y + b.y) / 2,
    frame: a.frame,
    imageSeq: a.imageSeq,
    source: `${a.source}|${b.source}`,
  };
}

/** Max horizontal deviation of a centerline from its straight well->front line. */
export function smileAmplitude(center: PixelPoint[]): number {
  if (center.length < 2) return 0;
  const first = center[0];
  const last = center[center.length - 1];
  let amp = 0;
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const len = Math.hypot(dx, dy) || 1;
  for (const p of center) {
    // perpendicular distance to the chord
    const cross = Math.abs(dx * (first.y - p.y) - dy * (first.x - p.x));
    amp = Math.max(amp, cross / len);
  }
  return amp;
}

export function buildLaneGeometry(
  laneId: string,
  imageSeq: number,
  leftBound: LaneBoundaryMaterial,
  rightBound: LaneBoundaryMaterial,
  params: ParamSet,
): LaneGeometryResult {
  const sampleCount = Math.max(
    32,
    Math.round(Math.max(polylineLength(leftBound.points), polylineLength(rightBound.points))),
  );
  const left = resampleByArc(leftBound.points, sampleCount).points;
  const right = resampleByArc(rightBound.points, sampleCount).points;
  const center: PixelPoint[] = left.map((p, i) => midpoint(p, right[i]));
  const { points: centerResampled, arcLengths } = resampleByArc(center, sampleCount);
  const totalArc = arcLengths[arcLengths.length - 1] ?? 0;
  const amp = smileAmplitude(centerResampled);
  const inputDigest = digestOf({
    laneId,
    imageSeq,
    left: leftBound.points.map((p) => [p.x, p.y]),
    right: rightBound.points.map((p) => [p.x, p.y]),
    params: params.version,
  });
  return {
    id: derivedId('geom', inputDigest, laneId),
    laneId,
    imageSeq,
    centerline: centerResampled,
    left,
    right,
    arcLengthsPx: arcLengths,
    totalArcLengthPx: totalArc,
    smileDetected: amp >= 3,
    smileAmplitudePx: amp,
    inputDigest,
    paramsVersion: params.version,
    parents: [leftBound.id, rightBound.id],
  };
}

/** Cross-section strip polygon at arc position with given half width. */
export function stripPolygonAt(
  geom: LaneGeometryResult,
  s: number,
  halfWidthPx: number,
): PixelPoint[] {
  const center = pointAtArc(geom.centerline, s);
  const before = pointAtArc(geom.centerline, Math.max(0, s - 1));
  const after = pointAtArc(geom.centerline, Math.min(geom.totalArcLengthPx, s + 1));
  let tx = after.x - before.x;
  let ty = after.y - before.y;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const nx = -ty;
  const ny = tx;
  const mk = (along: number, side: number): PixelPoint => ({
    x: center.x + tx * along + nx * halfWidthPx * side,
    y: center.y + ty * along + ny * halfWidthPx * side,
    frame: center.frame,
    imageSeq: center.imageSeq,
    source: 'strip:' + center.source,
  });
  return [mk(-1, -1), mk(-1, 1), mk(1, 1), mk(1, -1)];
}

export function laneHalfWidth(geom: LaneGeometryResult, s: number): number {
  const l = pointAtArc(geom.left, s);
  const r = pointAtArc(geom.right, s);
  return Math.max(1, Math.hypot(r.x - l.x, r.y - l.y) / 2);
}
