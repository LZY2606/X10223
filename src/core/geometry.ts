import type { CurvePoint, LaneGeometry } from '../shared/model.js';
import { impossible } from '../shared/errors.js';

export function polylineLength(points: CurvePoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += dist(points[i - 1]!, points[i]!);
  }
  return total;
}

export function dist(a: CurvePoint, b: CurvePoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function resample(points: CurvePoint[], step = 1): CurvePoint[] {
  if (points.length < 2) return points.map((p) => ({ ...p }));
  const total = polylineLength(points);
  const count = Math.max(2, Math.round(total / step) + 1);
  const out: CurvePoint[] = [];
  const lengths = [0];
  for (let i = 1; i < points.length; i++) lengths.push(lengths[i - 1]! + dist(points[i - 1]!, points[i]!));
  for (let k = 0; k < count; k++) {
    const s = (total * k) / (count - 1);
    out.push(pointAtLength(points, lengths, s));
  }
  return out;
}

function pointAtLength(points: CurvePoint[], lengths: number[], s: number): CurvePoint {
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

export function normalAt(points: CurvePoint[], index: number): CurvePoint {
  const i0 = Math.max(0, index - 1);
  const i1 = Math.min(points.length - 1, index + 1);
  const a = points[i0]!;
  const b = points[i1]!;
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const n = Math.hypot(dx, dy) || 1;
  return { x: -dy / n, y: dx / n };
}

export function migrationS(
  lane: LaneGeometry,
  point: CurvePoint,
): { s: number; cross: number; projected: CurvePoint } {
  const center = lane.center;
  if (center.length < 2) throw impossible('GEO-EMPTY-LANE', '泳道中心线点数不足', { laneId: lane.laneId });
  let best = Infinity;
  let bestIndex = 0;
  let bestT = 0;
  let bestA = center[0]!;
  let bestB = center[1]!;
  for (let i = 1; i < center.length; i++) {
    const a = center[i - 1]!;
    const b = center[i]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const segLen2 = abx * abx + aby * aby || 1e-9;
    let t = ((point.x - a.x) * abx + (point.y - a.y) * aby) / segLen2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + abx * t;
    const py = a.y + aby * t;
    const d2 = (point.x - px) ** 2 + (point.y - py) ** 2;
    if (d2 < best) {
      best = d2;
      bestIndex = i;
      bestT = t;
      bestA = a;
      bestB = b;
    }
  }
  const projected = { x: bestA.x + (bestB.x - bestA.x) * bestT, y: bestA.y + (bestB.y - bestA.y) * bestT };
  let s = 0;
  for (let i = 1; i < bestIndex; i++) s += dist(center[i - 1]!, center[i]!);
  s += dist(bestA, projected);
  if (lane.wellSide === 'bottom') s = polylineLength(center) - s;
  const cross = point.x === projected.x && point.y === projected.y ? 0 : Math.sign(crossProductSign(bestA, bestB, point)) * Math.sqrt(best);
  return { s, cross, projected };
}

function crossProductSign(a: CurvePoint, b: CurvePoint, p: CurvePoint): number {
  return (b.x - a.x) * (p.y - a.y) - (b.y - a.y) * (p.x - a.x);
}

export function laneWidthAt(lane: LaneGeometry, centerIndex: number): number {
  const idx = Math.min(centerIndex, lane.center.length - 1);
  const l = lane.left[Math.min(idx, lane.left.length - 1)] ?? lane.left[lane.left.length - 1]!;
  const r = lane.right[Math.min(idx, lane.right.length - 1)] ?? lane.right[lane.right.length - 1]!;
  const c = lane.center[idx]!;
  return dist(l, c) + dist(c, r);
}

export function rotatePointCw(p: CurvePoint, w: number, h: number, rotation: 90 | 180 | 270): CurvePoint {
  if (rotation === 90) return { x: h - p.y, y: p.x };
  if (rotation === 180) return { x: w - p.x, y: h - p.y };
  return { x: p.y, y: w - p.x };
}
