import type { PixelPoint } from './types.js';

export interface ProjectedPoint {
  /** 沿折线的弧长 s（从加样孔起） */
  arcLength: number;
  /** 相对中心线的横向偏移（负=左，正=右） */
  lateral: number;
  /** 投影后被吸附到中心线上的点 */
  centerPoint: PixelPoint;
  /** 投影落在线段上的 t∈[0,1]，越界由调用方判定 */
  segmentIndex: number;
  onCurve: boolean;
}

export function polylineLength(points: PixelPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return len;
}

/** 把点投影到折线，返回弧长/横向偏移。支持“微笑”弯曲泳道。 */
export function projectToPolyline(p: PixelPoint, points: PixelPoint[]): ProjectedPoint {
  let best: ProjectedPoint | null = null;
  let bestDist = Infinity;
  let cum = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const segLen = Math.hypot(vx, vy) || 1e-9;
    const t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / (segLen * segLen);
    const tc = Math.min(1, Math.max(0, t));
    const cx = a.x + tc * vx;
    const cy = a.y + tc * vy;
    const dist = Math.hypot(p.x - cx, p.y - cy);
    if (dist < bestDist) {
      bestDist = dist;
      const lateralVecX = -vy / segLen;
      const lateralVecY = vx / segLen;
      const lateral = (p.x - cx) * lateralVecX + (p.y - cy) * lateralVecY;
      best = {
        arcLength: cum + tc * segLen,
        lateral,
        centerPoint: { x: cx, y: cy, ref: p.ref },
        segmentIndex: i,
        onCurve: t >= 0 && t <= 1
      };
    }
    cum += segLen;
  }
  if (!best) throw new Error('empty centerline');
  return best;
}

/** 在折线上按弧长取点（用于绘制 lane 曲线与水平参照）。 */
export function sampleAtArcLength(points: PixelPoint[], s: number): PixelPoint | null {
  if (points.length === 0) return null;
  if (s <= 0) return points[0]!;
  let cum = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (cum + segLen >= s) {
      const t = (s - cum) / (segLen || 1e-9);
      return {
        x: a.x + t * (b.x - a.x),
        y: a.y + t * (b.y - a.y),
        ref: a.ref
      };
    }
    cum += segLen;
  }
  return points[points.length - 1]!;
}

/** 绕图像中心顺时针旋转 angleDeg 后的点坐标（显示帧变换，原图不变）。 */
export function rotatePoint(
  p: PixelPoint,
  width: number,
  height: number,
  angleDeg: number
): PixelPoint {
  const theta = (-angleDeg * Math.PI) / 180;
  const cx = (width - 1) / 2;
  const cy = (height - 1) / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const cos = Math.cos(theta);
  const sin = Math.sin(theta);
  const x = dx * cos - dy * sin + (angleDeg % 180 === 0 ? cx : cy);
  const y = dx * sin + dy * cos + (angleDeg % 180 === 0 ? cy : cx);
  return { x, y, ref: { ...p.ref, frameKind: 'display' } };
}

/** 旋转后图像尺寸。 */
export function rotatedSize(w: number, h: number, angleDeg: number): [number, number] {
  return angleDeg % 180 === 0 ? [w, h] : [h, w];
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
