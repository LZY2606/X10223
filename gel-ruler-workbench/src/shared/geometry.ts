import type { Point, Polyline } from './types.js';

export function pt(x: number, y: number): Point {
  return { x, y };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 折线累计弧长（像素） */
export function arcLengths(poly: Point[]): number[] {
  const out = [0];
  for (let i = 1; i < poly.length; i++) out.push(out[i - 1] + dist(poly[i - 1], poly[i]));
  return out;
}

export function totalLength(poly: Point[]): number {
  const a = arcLengths(poly);
  return a[a.length - 1] ?? 0;
}

/** 在折线上按弧长 s 插值出点（像素） */
export function pointAt(poly: Point[], s: number): Point {
  if (poly.length === 1) return { ...poly[0] };
  const cum = arcLengths(poly);
  const total = cum[cum.length - 1];
  if (s <= 0) return { ...poly[0] };
  if (s >= total) return { ...poly[poly.length - 1] };
  for (let i = 1; i < cum.length; i++) {
    if (s <= cum[i]) {
      const segLen = cum[i] - cum[i - 1] || 1;
      const t = (s - cum[i - 1]) / segLen;
      return {
        x: poly[i - 1].x + (poly[i].x - poly[i - 1].x) * t,
        y: poly[i - 1].y + (poly[i].y - poly[i - 1].y) * t
      };
    }
  }
  return { ...poly[poly.length - 1] };
}

/** 点到折线的投影弧长 s（最近点） */
export function projectToPolyline(poly: Point[], p: Point): number {
  let bestS = 0;
  let bestD = Infinity;
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1];
    const b = poly[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + vx * t;
    const qy = a.y + vy * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bestD) {
      bestD = d;
      bestS = acc + Math.hypot(qx - a.x, qy - a.y);
    }
    acc += Math.hypot(vx, vy);
  }
  return bestS;
}

export function polyline(points: Point[], frame: Polyline['frame'] = 'source'): Polyline {
  return { frame, points };
}

/** 旋转坐标变换：source 像素 -> 显示像素。尺寸是源图尺寸 */
export function rotatePoint(
  p: Point,
  orientation: 'as-shot' | 'rotate-90' | 'rotate-180' | 'rotate-270',
  w: number,
  h: number
): Point {
  switch (orientation) {
    case 'rotate-90':
      return { x: h - p.y, y: p.x };
    case 'rotate-180':
      return { x: w - p.x, y: h - p.y };
    case 'rotate-270':
      return { x: p.y, y: w - p.x };
    default:
      return { ...p };
  }
}
