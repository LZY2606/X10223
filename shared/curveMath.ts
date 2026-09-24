import type { Vec2 } from "./types";

export interface ArcCurve {
  points: Vec2[];
  cumulative: number[];
}

export function buildCurve(points: Vec2[]): ArcCurve {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) {
    cumulative.push(cumulative[i - 1] + Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y));
  }
  return { points, cumulative };
}

export function interpAt(curve: ArcCurve, s: number): Vec2 {
  const { points, cumulative } = curve;
  const total = cumulative[cumulative.length - 1];
  if (s <= 0) return points[0];
  if (s >= total) return points[points.length - 1];
  let i = 1;
  while (i < cumulative.length && cumulative[i] < s) i++;
  if (i >= cumulative.length) return points[points.length - 1];
  const seg = cumulative[i] - cumulative[i - 1] || 1;
  const t = (s - cumulative[i - 1]) / seg;
  return {
    x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
    y: points[i - 1].y + (points[i].y - points[i - 1].y) * t
  };
}

export function projectPoint(p: Vec2, curve: ArcCurve): { s: number; d: number; onCurve: Vec2 } {
  const total = curve.cumulative[curve.cumulative.length - 1];
  let best = { s: 0, d: Infinity, onCurve: curve.points[0] };
  const STEPS = 300;
  for (let i = 0; i <= STEPS; i++) {
    const s = (total * i) / STEPS;
    const c = interpAt(curve, s);
    const d = Math.hypot(p.x - c.x, p.y - c.y);
    if (d < best.d) best = { s, d, onCurve: c };
  }
  return best;
}

export function boundaryPolygon(center: Vec2[], halfWidth: number): Vec2[] {
  const curve = buildCurve(center);
  const total = curve.cumulative[curve.cumulative.length - 1];
  const STEPS = Math.max(10, center.length * 3);
  const left: Vec2[] = [];
  const right: Vec2[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const s = (total * i) / STEPS;
    const c = interpAt(curve, s);
    const a = interpAt(curve, Math.max(0, s - 0.75));
    const b = interpAt(curve, Math.min(total, s + 0.75));
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const tn = Math.hypot(tx, ty) || 1;
    const nx = -ty / tn;
    const ny = tx / tn;
    left.push({ x: c.x + nx * halfWidth, y: c.y + ny * halfWidth });
    right.push({ x: c.x - nx * halfWidth, y: c.y - ny * halfWidth });
  }
  return [...left, ...right.reverse()];
}
