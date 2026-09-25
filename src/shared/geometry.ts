import type { Point } from "./domain.js";

export function dist(a: Point, b: Point): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export interface ArcLocus {
  points: Point[];
  cum: number[];
}

export function arcLocus(polyline: Point[]): ArcLocus {
  const cum = [0];
  for (let i = 1; i < polyline.length; i++) {
    cum.push((cum[i - 1] ?? 0) + dist(polyline[i - 1] as Point, polyline[i] as Point));
  }
  return { points: polyline, cum };
}

export function pointAtArc(locus: ArcLocus, s: number): Point {
  const { points, cum } = locus;
  if (s <= 0) return points[0] as Point;
  const last = cum[cum.length - 1] ?? 0;
  if (s >= last) return points[points.length - 1] as Point;
  for (let i = 1; i < cum.length; i++) {
    const c0 = cum[i - 1] as number;
    const c1 = cum[i] as number;
    if (s <= c1) {
      const t = (s - c0) / (c1 - c0);
      const p0 = points[i - 1] as Point;
      const p1 = points[i] as Point;
      return { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
    }
  }
  return points[points.length - 1] as Point;
}

export function arcOfPoint(locus: ArcLocus, p: Point): number {
  let bestS = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (let i = 1; i < locus.points.length; i++) {
    const a = locus.points[i - 1] as Point;
    const b = locus.points[i] as Point;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
    const qx = a.x + vx * t;
    const qy = a.y + vy * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bestD) {
      bestD = d;
      bestS = (locus.cum[i - 1] as number) + t * ((locus.cum[i] as number) - (locus.cum[i - 1] as number));
    }
  }
  return bestS;
}

export function rotatePointCw(p: Point, deg: number, width: number, height: number): Point {
  const norm = ((deg % 360) + 360) % 360;
  if (norm === 0) return { ...p };
  if (norm === 90) return { x: height - p.y, y: p.x };
  if (norm === 180) return { x: width - p.x, y: height - p.y };
  if (norm === 270) return { x: p.y, y: width - p.x };
  const rad = (-norm * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  return { x: p.x * cos - p.y * sin, y: p.x * sin + p.y * cos };
}

export function rotatedDimensions(width: number, height: number, deg: number): [number, number] {
  const norm = ((deg % 360) + 360) % 360;
  return norm === 90 || norm === 270 ? [height, width] : [width, height];
}
