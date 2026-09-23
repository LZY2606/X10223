import type { PixelPoint } from './types.js';

/** 折线工具：弯曲泳道的所有距离计算都沿中心线弧长，而非直接用 y。 */

export function polylineLength(points: PixelPoint[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += distance(points[i - 1], points[i]);
  }
  return total;
}

export function distance(a: PixelPoint, b: PixelPoint): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 沿折线累积弧长表。 */
export function arcTable(points: PixelPoint[]): { s: number; point: PixelPoint }[] {
  const table: { s: number; point: PixelPoint }[] = [{ s: 0, point: points[0] }];
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    s += distance(points[i - 1], points[i]);
    table.push({ s, point: points[i] });
  }
  return table;
}

/** 返回折线上弧长 s 处的插值点与切线。 */
export function pointAtArcLength(
  points: PixelPoint[],
  s: number,
): { point: PixelPoint; tangent: PixelPoint; cumulative: { s: number; point: PixelPoint }[] } {
  const table = arcTable(points);
  const total = table[table.length - 1].s;
  const clamped = Math.max(0, Math.min(total, s));
  for (let i = 1; i < table.length; i++) {
    if (clamped <= table[i].s) {
      const a = table[i - 1];
      const b = table[i];
      const span = b.s - a.s || 1;
      const t = (clamped - a.s) / span;
      return {
        point: { x: a.point.x + (b.point.x - a.point.x) * t, y: a.point.y + (b.point.y - a.point.y) * t },
        tangent: { x: (b.point.x - a.point.x) / span, y: (b.point.y - a.point.y) / span },
        cumulative: table,
      };
    }
  }
  const last = points[points.length - 1];
  return { point: last, tangent: { x: 0, y: 1 }, cumulative: table };
}

/**
 * 把点 p 投影到折线上：返回沿弧长 s、横向偏移 px、到折线的最近距离。
 * 用分段线性投影。
 */
export function projectToPolyline(
  points: PixelPoint[],
  p: PixelPoint,
): { s: number; lateralOffset: number; distance: number; nearest: PixelPoint } {
  let best: { s: number; lateralOffset: number; distance: number; nearest: PixelPoint } | null = null;
  let s0 = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy) || 1;
    const ux = dx / segLen;
    const uy = dy / segLen;
    let t = ((p.x - a.x) * ux + (p.y - a.y) * uy) / segLen;
    t = Math.max(0, Math.min(1, t));
    const nearest = { x: a.x + dx * t, y: a.y + dy * t };
    const d = Math.hypot(p.x - nearest.x, p.y - nearest.y);
    const lateral = (p.x - nearest.x) * -uy + (p.y - nearest.y) * ux;
    const candidate = { s: s0 + t * segLen, lateralOffset: lateral, distance: d, nearest };
    if (!best || candidate.distance < best.distance) best = candidate;
    s0 += segLen;
  }
  return best!;
}

/** 90/180/270 度顺时针旋转像素坐标。 */
export function rotatePoint(p: PixelPoint, deg: number, w: number, h: number): PixelPoint {
  switch (((deg % 360) + 360) % 360) {
    case 90:
      return { x: h - 1 - p.y, y: p.x };
    case 180:
      return { x: w - 1 - p.x, y: h - 1 - p.y };
    case 270:
      return { x: p.y, y: w - 1 - p.x };
    default:
      return { ...p };
  }
}

export function rotatePolyline(points: PixelPoint[], deg: number, w: number, h: number): PixelPoint[] {
  return points.map((p) => rotatePoint(p, deg, w, h));
}

/** 有序弧长数组上的分段线性插值。 */
export function interp(xs: number[], ys: number[], x: number): number | null {
  if (xs.length === 0 || x < xs[0] || x > xs[xs.length - 1]) return null;
  for (let i = 1; i < xs.length; i++) {
    if (x <= xs[i]) {
      const t = (x - xs[i - 1]) / (xs[i] - xs[i - 1] || 1);
      return ys[i - 1] + t * (ys[i] - ys[i - 1]);
    }
  }
  return ys[ys.length - 1];
}
