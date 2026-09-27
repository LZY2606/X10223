import type { PixelPoint, Rotation } from './types.js';

export function pt(x: number, y: number, frame: PixelPoint['frame'] = 'upright'): PixelPoint {
  return { x, y, frame };
}

/** 原始拍摄帧像素 -> 转正帧像素（shotRotation 为顺时针校正角） */
export function shotToUpright(p: PixelPoint, shotRotation: Rotation, shotW: number, shotH: number): PixelPoint {
  const { x, y } = p;
  switch (shotRotation) {
    case 0:
      return { x, y, frame: 'upright' };
    case 90:
      return { x: shotH - 1 - y, y: x, frame: 'upright' };
    case 180:
      return { x: shotW - 1 - x, y: shotH - 1 - y, frame: 'upright' };
    case 270:
      return { x: y, y: shotW - 1 - x, frame: 'upright' };
  }
}

export function uprightToShot(p: PixelPoint, shotRotation: Rotation, shotW: number, shotH: number): PixelPoint {
  const inv: Record<Rotation, Rotation> = { 0: 0, 90: 270, 180: 180, 270: 90 };
  const upW = shotRotation % 180 === 0 ? shotW : shotH;
  const upH = shotRotation % 180 === 0 ? shotH : shotW;
  return shotToUpright(p, inv[shotRotation], upW, upH);
}

export function uprightDims(shotW: number, shotH: number, r: Rotation): { width: number; height: number } {
  return r % 180 === 0 ? { width: shotW, height: shotH } : { width: shotH, height: shotW };
}

export function dist(a: PixelPoint, b: PixelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface CurveMetric {
  totalLength: number;
  chord: number;
  curvature: number; // 弧长/弦长 - 1
  cumulative: number[];
}

export function curveMetric(points: PixelPoint[]): CurveMetric {
  const cumulative = [0];
  for (let i = 1; i < points.length; i++) cumulative[i] = cumulative[i - 1] + dist(points[i - 1], points[i]);
  const totalLength = cumulative[cumulative.length - 1];
  const chord = dist(points[0], points[points.length - 1]);
  const curvature = chord > 0 ? totalLength / chord - 1 : 0;
  return { totalLength, chord, curvature, cumulative };
}

export interface Projection {
  m: number; // 归一化弧长 0..1
  s: number; // 弧长像素
  point: PixelPoint;
  distance: number;
}

/** 把点投影到折线，返回沿弧长的归一化位置（微笑泳道下与 y 不同） */
export function projectToCurve(points: PixelPoint[], target: PixelPoint): Projection {
  const { cumulative, totalLength } = curveMetric(points);
  let best = { s: 0, distance: Infinity, point: points[0] };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 > 0 ? ((target.x - a.x) * vx + (target.y - a.y) * vy) / len2 : 0;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + t * vx;
    const cy = a.y + t * vy;
    const d = Math.hypot(target.x - cx, target.y - cy);
    if (d < best.distance) {
      const segLen = Math.sqrt(len2);
      best = { s: cumulative[i] + t * segLen, distance: d, point: { x: cx, y: cy, frame: 'upright' } };
    }
  }
  return { m: totalLength > 0 ? best.s / totalLength : 0, s: best.s, point: best.point, distance: best.distance };
}

/** 取归一化弧长 m 处的折线上点 */
export function pointAtM(points: PixelPoint[], m: number): PixelPoint {
  const { cumulative, totalLength } = curveMetric(points);
  const s = Math.max(0, Math.min(1, m)) * totalLength;
  for (let i = 0; i < points.length - 1; i++) {
    if (s <= cumulative[i + 1] || i === points.length - 2) {
      const segLen = cumulative[i + 1] - cumulative[i];
      const t = segLen > 0 ? (s - cumulative[i]) / segLen : 0;
      return { x: points[i].x + t * (points[i + 1].x - points[i].x), y: points[i].y + t * (points[i + 1].y - points[i].y), frame: 'upright' };
    }
  }
  return points[points.length - 1];
}

/** 由中心线向两侧法向偏移构造左/右边界折线 */
export function offsetCurve(center: PixelPoint[], halfWidth: number, side: -1 | 1): PixelPoint[] {
  return center.map((p, i) => {
    const a = center[Math.max(0, i - 1)];
    const b = center[Math.min(center.length - 1, i + 1)];
    let nx = b.y - a.y;
    let ny = -(b.x - a.x);
    const n = Math.hypot(nx, ny) || 1;
    nx /= n; ny /= n;
    return { x: p.x + side * halfWidth * nx, y: p.y + side * halfWidth * ny, frame: 'upright' as const };
  });
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
