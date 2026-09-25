import type { ControlPoint, Orientation, PointPx } from '../shared/types.js';

export interface ArcSegment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  s0: number;
  len: number;
}

export function polylineSegments(points: ControlPoint[]): ArcSegment[] {
  const segments: ArcSegment[] = [];
  let s0 = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, s0, len });
    s0 += len;
  }
  return segments;
}

export function totalLength(points: ControlPoint[]): number {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    total += Math.hypot(points[i + 1]!.x - points[i]!.x, points[i + 1]!.y - points[i]!.y);
  }
  return total;
}

export function pointAtS(points: ControlPoint[], s: number): PointPx & { tangentX: number; tangentY: number } {
  const segs = polylineSegments(points);
  if (segs.length === 0) {
    const p = points[0] ?? { x: 0, y: 0 };
    return { x: p.x, y: p.y, tangentX: 0, tangentY: 1 };
  }
  for (const seg of segs) {
    if (s <= seg.s0 + seg.len + 1e-9) {
      const t = seg.len === 0 ? 0 : Math.min(1, Math.max(0, (s - seg.s0) / seg.len));
      return {
        x: seg.ax + (seg.bx - seg.ax) * t,
        y: seg.ay + (seg.by - seg.ay) * t,
        tangentX: seg.len === 0 ? 0 : (seg.bx - seg.ax) / seg.len,
        tangentY: seg.len === 0 ? 1 : (seg.by - seg.ay) / seg.len,
      };
    }
  }
  const last = segs[segs.length - 1]!;
  return { x: last.bx, y: last.by, tangentX: last.len === 0 ? 0 : (last.bx - last.ax) / last.len, tangentY: last.len === 0 ? 1 : (last.by - last.ay) / last.len };
}

export function projectToCurve(points: ControlPoint[], x: number, y: number): { s: number; x: number; y: number; distance: number } {
  const segs = polylineSegments(points);
  let best = { s: 0, x: 0, y: 0, distance: Number.POSITIVE_INFINITY };
  for (const seg of segs) {
    const vx = seg.bx - seg.ax;
    const vy = seg.by - seg.ay;
    const wx = x - seg.ax;
    const wy = y - seg.ay;
    const denom = vx * vx + vy * vy;
    const t = denom === 0 ? 0 : Math.min(1, Math.max(0, (wx * vx + wy * vy) / denom));
    const px = seg.ax + vx * t;
    const py = seg.ay + vy * t;
    const distance = Math.hypot(x - px, y - py);
    if (distance < best.distance) {
      best = { s: seg.s0 + seg.len * t, x: px, y: py, distance };
    }
  }
  return best;
}

export function resampleCurve(points: ControlPoint[], count = 64): ControlPoint[] {
  const total = totalLength(points);
  const out: ControlPoint[] = [];
  for (let i = 0; i < count; i++) {
    const s = (total * i) / Math.max(1, count - 1);
    const p = pointAtS(points, s);
    out.push({ x: round2(p.x), y: round2(p.y), s: round2(s) });
  }
  return out;
}

export function smileMetric(points: ControlPoint[]): number {
  if (points.length < 3) return 0;
  const first = points[0]!;
  const last = points[points.length - 1]!;
  const dx = last.x - first.x;
  const dy = last.y - first.y;
  const length = Math.hypot(dx, dy) || 1;
  let maxDev = 0;
  for (let i = 1; i < points.length - 1; i++) {
    const p = points[i]!;
    const cross = Math.abs(dx * (first.y - p.y) - dy * (first.x - p.x));
    maxDev = Math.max(maxDev, cross / length);
  }
  return round2(maxDev);
}

export function isCurved(points: ControlPoint[], tolerancePx = 2): boolean {
  return smileMetric(points) > tolerancePx;
}

export function boundingBox(points: ControlPoint[]) {
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  return { minX: Math.min(...xs), minY: Math.min(...ys), maxX: Math.max(...xs), maxY: Math.max(...ys) };
}

export function orientationTransform(o: Orientation, w: number, h: number) {
  switch (o) {
    case 'rotated-90-cw':
    case 'left-to-right':
      return { width: h, height: w, map: (x: number, y: number): PointPx => ({ x: h - 1 - y, y: x }) };
    case 'rotated-90-ccw':
    case 'right-to-left':
      return { width: h, height: w, map: (x: number, y: number): PointPx => ({ x: y, y: w - 1 - x }) };
    case 'rotated-180':
    case 'bottom-to-top':
      return { width: w, height: h, map: (x: number, y: number): PointPx => ({ x: w - 1 - x, y: h - 1 - y }) };
    default:
      return { width: w, height: h, map: (x: number, y: number): PointPx => ({ x, y }) };
  }
}

export function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

export function interpolate(xs: number[], ys: number[], x: number): number | undefined {
  if (xs.length === 0) return undefined;
  if (x < xs[0]! || x > xs[xs.length - 1]!) return undefined;
  for (let i = 0; i < xs.length - 1; i++) {
    const x0 = xs[i]!;
    const x1 = xs[i + 1]!;
    if (x >= x0 && x <= x1) {
      const t = x1 === x0 ? 0 : (x - x0) / (x1 - x0);
      return ys[i]! + (ys[i + 1]! - ys[i]!) * t;
    }
  }
  return ys[ys.length - 1];
}
