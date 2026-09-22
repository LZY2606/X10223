import type { CoordFrame, Point } from './types.js';

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 折线累计弧长（px），逐点返回，长度与输入相同 */
export function polylineArcLengths(points: Point[]): number[] {
  const out = [0];
  for (let i = 1; i < points.length; i++) out[i] = out[i - 1] + dist(points[i - 1], points[i]);
  return out;
}

/**
 * 条带中心投影到泳道中心曲线：返回沿曲线的弧长（从加样孔端起算）
 * 与最近点。微笑弯曲时必须按弧长而不是图像 y 比较分子量。
 */
export function projectToCenterline(center: Point, polyline: Point[]): { alongPx: number; nearest: Point; lateralPx: number } {
  let best = { t: 0, seg: 0, d2: Infinity, nearest: polyline[0] };
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i];
    const b = polyline[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1e-9;
    const t = Math.min(1, Math.max(0, ((center.x - a.x) * vx + (center.y - a.y) * vy) / len2));
    const px = a.x + vx * t;
    const py = a.y + vy * t;
    const d2 = (center.x - px) ** 2 + (center.y - py) ** 2;
    if (d2 < best.d2) best = { t, seg: i, d2, nearest: { x: px, y: py } };
  }
  const cum = polylineArcLengths(polyline);
  const segLen = dist(polyline[best.seg], polyline[best.seg + 1] ?? polyline[best.seg]);
  return {
    alongPx: cum[best.seg] + best.t * segLen,
    nearest: best.nearest,
    lateralPx: Math.sqrt(best.d2),
  };
}

/** raw 像素坐标 -> upright（迁移方向竖直向下）坐标，绕图像中心旋转 */
export function rawToUpright(p: Point, frame: CoordFrame): Point {
  if (frame.kind === 'upright' || frame.rotationDeg === 0) return { ...p };
  const theta = (-frame.rotationDeg * Math.PI) / 180;
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  return {
    x: cx + dx * Math.cos(theta) - dy * Math.sin(theta),
    y: cy + dx * Math.sin(theta) + dy * Math.cos(theta),
  };
}

export function uprightToRaw(p: Point, frame: CoordFrame): Point {
  if (frame.kind === 'upright' || frame.rotationDeg === 0) return { ...p };
  const theta = (frame.rotationDeg * Math.PI) / 180;
  const cx = frame.width / 2;
  const cy = frame.height / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  return {
    x: cx + dx * Math.cos(theta) - dy * Math.sin(theta),
    y: cy + dx * Math.sin(theta) + dy * Math.cos(theta),
  };
}

/** 旋转后图像外框尺寸 */
export function rotatedSize(w: number, h: number, deg: number): { width: number; height: number } {
  if (deg === 0 || deg === 180) return { width: w, height: h };
  return { width: h, height: w };
}

/** 线性插值 */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}
