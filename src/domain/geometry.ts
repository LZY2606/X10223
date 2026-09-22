import type { PixelPoint } from './types';

/** 折线总长度（px） */
export function polylineLength(points: PixelPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += distance(points[i - 1]!, points[i]!);
  }
  return len;
}

export function distance(a: PixelPoint, b: PixelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 折线在弧长 s 处的点（线性插值，px） */
export function pointAtArcLength(points: PixelPoint[], s: number): PixelPoint {
  if (points.length === 0) return { x: NaN, y: NaN };
  if (s <= 0) return { ...points[0]! };
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = distance(points[i - 1]!, points[i]!);
    if (acc + seg >= s) {
      const t = seg === 0 ? 0 : (s - acc) / seg;
      return {
        x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * t,
        y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * t,
      };
    }
    acc += seg;
  }
  return { ...points[points.length - 1]! };
}

/**
 * 点 p 在折线 centerline 上的投影弧长（px）。
 * “微笑”弯曲时不能用 y 当迁移量：必须在各自 lane 中心线上取弧长。
 */
export function projectionArcLength(centerline: PixelPoint[], p: PixelPoint): { s: number; lateral: number } {
  let bestS = 0;
  let bestD = Infinity;
  let acc = 0;
  for (let i = 1; i < centerline.length; i++) {
    const a = centerline[i - 1]!;
    const b = centerline[i]!;
    const segLen = distance(a, b);
    const t = segLen === 0 ? 0 : clamp(((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (segLen * segLen), 0, 1);
    const qx = a.x + (b.x - a.x) * t;
    const qy = a.y + (b.y - a.y) * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bestD) {
      bestD = d;
      bestS = acc + segLen * t;
    }
    acc += segLen;
  }
  return { s: bestS, lateral: bestD };
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}

/** 顺时针旋转 deg 度后图像像素坐标（绕图像中心，旋转后画布按交换尺寸处理） */
export function rotatePointCW(p: PixelPoint, deg: number, w: number, h: number): PixelPoint {
  const norm = ((deg % 360) + 360) % 360;
  if (norm === 0) return { ...p };
  const rad = (norm * Math.PI) / 180;
  // 图像坐标 y 向下：顺时针视觉旋转对应
  const cx = w / 2;
  const cy = h / 2;
  const dx = p.x - cx;
  const dy = p.y - cy;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const x2 = cos * dx + sin * dy;
  const y2 = -sin * dx + cos * dy;
  const swap = norm === 90 || norm === 270;
  const nw = swap ? h : w;
  const nh = swap ? w : h;
  return { x: x2 + nw / 2, y: y2 + nh / 2 };
}
