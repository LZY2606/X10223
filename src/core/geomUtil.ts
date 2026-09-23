import type { CurvePoint } from '../shared/model.js';

export function polylineLength(points: CurvePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  return total;
}

export function resample(points: CurvePoint[], step = 1): CurvePoint[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const total = polylineLength(points);
  const count = Math.max(2, Math.ceil(total / step) + 1);
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  const out: CurvePoint[] = [];
  for (let k = 0; k < count; k++) {
    const s = (total * k) / (count - 1);
    out.push(pointAtLength(points, lengths, s));
  }
  return out;
}

export function pointAtLength(points: CurvePoint[], lengths: number[], s: number): CurvePoint {
  if (s <= 0) return { ...points[0]! };
  const total = lengths[lengths.length - 1]!;
  if (s >= total) return { ...points[points.length - 1]! };
  let i = 1;
  while (lengths[i]! < s) i++;
  const segLen = lengths[i]! - lengths[i - 1]!;
  const t = segLen === 0 ? 0 : (s - lengths[i - 1]!) / segLen;
  const a = points[i - 1]!;
  const b = points[i]!;
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

export function pointAlong(points: CurvePoint[], s: number): CurvePoint {
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y));
  return pointAtLength(points, lengths, s);
}
