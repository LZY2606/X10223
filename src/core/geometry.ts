import type { PixelPoint } from '../shared/types';

export interface Vec2 {
  x: number;
  y: number;
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

export function lerpPoint(a: Vec2, b: Vec2, t: number): Vec2 {
  return { x: lerp(a.x, b.x, t), y: lerp(a.y, b.y, t) };
}

/** 折线累计弧长。 */
export function polylineArcLength(points: Vec2[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

/** 折线上按弧长参数 s（0..length）取点。 */
export function pointOnPolyline(points: Vec2[], s: number): Vec2 {
  if (points.length === 1) return { ...points[0] };
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const segLen = dist(points[i - 1], points[i]);
    if (s <= acc + segLen) {
      const t = segLen === 0 ? 0 : (s - acc) / segLen;
      return lerpPoint(points[i - 1], points[i], t);
    }
    acc += segLen;
  }
  return { ...points[points.length - 1] };
}

/** 点到折线最近点，返回弧长参数 s、最近点与投影残差（像素）。 */
export function nearestOnPolyline(
  points: Vec2[],
  p: Vec2
): { s: number; point: Vec2; residualPx: number } {
  let best = { s: 0, point: { ...points[0] }, residualPx: Infinity };
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = dist(a, b);
    const t =
      segLen === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (segLen * segLen)));
    const q = lerpPoint(a, b, t);
    const d = dist(p, q);
    if (d < best.residualPx) best = { s: acc + t * segLen, point: q, residualPx: d };
    acc += segLen;
  }
  return best;
}

/**
 * 顺时针旋转 deg 度的帧变换。坐标以图像中心为旋转中心。
 * frameFromImage：把原始图像像素坐标变换到旋转后分析帧。
 * 图像本身永不被原地改写：旋转只是带版本的坐标帧，来源仍可回溯原图。
 */
export function rotatePoint(
  p: PixelPoint,
  deg: number,
  srcW: number,
  srcH: number,
  dstW: number,
  dstH: number
): PixelPoint {
  if (((deg % 360) + 360) % 360 === 0) return { x: p.x, y: p.y };
  const theta = (-deg * Math.PI) / 180; // 顺时针
  const cx = (srcW - 1) / 2;
  const cy = (srcH - 1) / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const x = dx * Math.cos(theta) - dy * Math.sin(theta) + (dstW - 1) / 2;
  const y = dx * Math.sin(theta) + dy * Math.cos(theta) + (dstH - 1) / 2;
  return { x, y };
}

export function rotatedDims(w: number, h: number, deg: number): { w: number; h: number } {
  const norm = ((deg % 360) + 360) % 360;
  return norm === 90 || norm === 270 ? { w: h, h: w } : { w, h };
}

/** 点在多边形内（射线法）。 */
export function pointInPolygon(p: Vec2, poly: Vec2[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const pi = poly[i];
    const pj = poly[j];
    if (
      pi.y > p.y !== pj.y > p.y &&
      p.x < ((pj.x - pi.x) * (p.y - pi.y)) / (pj.y - pi.y) + pi.x
    )
      inside = !inside;
  }
  return inside;
}
