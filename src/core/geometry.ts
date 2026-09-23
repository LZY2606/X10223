import type { Orientation, Vec } from '../shared/types.js';

// 多段折线几何：弧长、按弧长取点、点到中心线投影。
// 所有坐标在 working frame；微笑弯曲的关键在于迁移量用弧长 s，而非像素行号 y。

export interface Projection { point: Vec; s: number; t: number; distance: number; segmentIndex: number; }

export function polyLength(points: Vec[]): number {
  let total = 0;
  for (let i = 1; i < points.length; i++) total += dist(points[i - 1], points[i]);
  return total;
}

export function dist(a: Vec, b: Vec): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function pointAt(points: Vec[], s: number): { point: Vec; t: number; segmentIndex: number } {
  let remaining = s;
  for (let i = 1; i < points.length; i++) {
    const seg = dist(points[i - 1], points[i]);
    if (remaining <= seg || i === points.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, Math.max(0, remaining / seg));
      return {
        point: {
          x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
          y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
        },
        t,
        segmentIndex: i - 1,
      };
    }
    remaining -= seg;
  }
  const last = points[points.length - 1];
  return { point: { ...last }, t: 1, segmentIndex: Math.max(0, points.length - 2) };
}

export function projectToCurve(points: Vec[], p: Vec): Projection {
  let best: Projection | null = null;
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const segLen = dist(a, b);
    const t = segLen === 0 ? 0 : clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (segLen * segLen), 0, 1);
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const distance = dist(p, q);
    const candidate: Projection = { point: q, s: acc + t * segLen, t, distance, segmentIndex: i - 1 };
    if (!best || candidate.distance < best.distance) best = candidate;
    acc += segLen;
  }
  return best!;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

// 方向变换：raw -> working。泳道材料保留 raw 像素来源，派生投影坐标独立保存。
export function transformPoint(p: Vec, w: number, h: number, orientation: Orientation): Vec {
  switch (orientation) {
    case 'as_imported':
      return { ...p };
    case 'rotate_cw_90':
      return { x: h - p.y, y: p.x };
    case 'rotate_180':
      return { x: w - p.x, y: h - p.y };
    case 'rotate_ccw_90':
      return { x: p.y, y: w - p.x };
  }
}

export function transformPoints(points: Vec[], w: number, h: number, orientation: Orientation): Vec[] {
  return points.map((p) => transformPoint(p, w, h, orientation));
}

export function workingDims(w: number, h: number, orientation: Orientation): { w: number; h: number } {
  return orientation === 'rotate_cw_90' || orientation === 'rotate_ccw_90' ? { w: h, h: w } : { w, h };
}

export function bendAtRow(curve: Vec[]): number {
  // 弯曲程度：中心线最大横向偏移相对于直线连接
  if (curve.length < 2) return 0;
  const a = curve[0];
  const b = curve[curve.length - 1];
  let maxDev = 0;
  for (const p of curve) {
    const t = b.y === a.y ? 0 : (p.y - a.y) / (b.y - a.y);
    const straightX = a.x + (b.x - a.x) * t;
    maxDev = Math.max(maxDev, Math.abs(p.x - straightX));
  }
  return maxDev;
}
