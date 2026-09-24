import type { PixelPoint } from './types.js';

export interface Polyline {
  points: PixelPoint[];
  /** 累计弧长 */
  cumLen: number[];
  totalLen: number;
}

export function buildPolyline(points: PixelPoint[]): Polyline {
  const cumLen: number[] = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    cumLen.push(cumLen[i - 1] + Math.hypot(dx, dy));
  }
  return { points, cumLen, totalLen: cumLen[cumLen.length - 1] ?? 0 };
}

/** 弧长 s 处的折线坐标 */
export function pointAt(poly: Polyline, s: number): PixelPoint {
  const { points, cumLen, totalLen } = poly;
  if (points.length === 0) throw new Error('empty polyline');
  const clamped = Math.max(0, Math.min(totalLen, s));
  for (let i = 1; i < cumLen.length; i++) {
    if (clamped <= cumLen[i]) {
      const segLen = cumLen[i] - cumLen[i - 1] || 1;
      const t = (clamped - cumLen[i - 1]) / segLen;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
        frame: points[i].frame
      };
    }
  }
  return { ...points[points.length - 1] };
}

/**
 * 点到折线的投影：返回弧长 s 与横向偏移 d。
 * 弯曲泳道上 band 中心先投影到中心线，得到“迁移弧长”，
 * 这是“微笑弯曲使同一高度不等于同一分子量”的几何基础。
 */
export function projectToPolyline(poly: Polyline, p: { x: number; y: number }) {
  let bestS = 0;
  let bestD = Infinity;
  let bestX = 0;
  let bestY = 0;
  for (let i = 1; i < poly.points.length; i++) {
    const a = poly.points[i - 1];
    const b = poly.points[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1e-9;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
    const qx = a.x + vx * t;
    const qy = a.y + vy * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bestD) {
      bestD = d;
      const segLen = poly.cumLen[i] - poly.cumLen[i - 1];
      bestS = poly.cumLen[i - 1] + segLen * t;
      bestX = qx;
      bestY = qy;
    }
  }
  return { s: bestS, lateral: bestD, qx: bestX, qy: bestY };
}

/** 帧旋转换算：把原始帧像素坐标换到显示帧 */
export function rotatePoint(
  p: { x: number; y: number },
  frame: 'original' | 'rot90' | 'rot180' | 'rot270',
  w: number,
  h: number
): { x: number; y: number } {
  switch (frame) {
    case 'rot90':
      return { x: h - p.y, y: p.x };
    case 'rot180':
      return { x: w - p.x, y: h - p.y };
    case 'rot270':
      return { x: p.y, y: w - p.x };
    default:
      return { x: p.x, y: p.y };
  }
}

export function frameDims(
  frame: 'original' | 'rot90' | 'rot180' | 'rot270',
  w: number,
  h: number
): { w: number; h: number } {
  return frame === 'rot90' || frame === 'rot270' ? { w: h, h: w } : { w, h };
}

/** 点在多边形内（用于有效区域判定） */
export function pointInPolygon(p: { x: number; y: number }, poly: PixelPoint[]): boolean {
  let inside = false;
  for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
    const xi = poly[i].x;
    const yi = poly[i].y;
    const xj = poly[j].x;
    const yj = poly[j].y;
    const hit =
      yi > p.y !== yj > p.y && p.x < ((xj - xi) * (p.y - yi)) / (yj - yi || 1e-12) + xi;
    if (hit) inside = !inside;
  }
  return inside;
}
