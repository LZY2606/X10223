import type { PixelPoint, Quantity, Transform } from './types.js';
import { q } from './quantities.js';

export interface Pt {
  x: number;
  y: number;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 折线总弧长（像素）。 */
export function polylineLength(points: Pt[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) len += dist(points[i - 1]!, points[i]!);
  return len;
}

/** 沿折线走 s 像素得到的点；s 越界返回端点。 */
export function pointAtArcLength(points: Pt[], s: number): Pt {
  let remaining = Math.max(0, s);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = dist(a, b);
    if (remaining <= seg || i === points.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, remaining / seg);
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    remaining -= seg;
  }
  return points[0] ?? { x: 0, y: 0 };
}

/** 弧长 s 处的切线角（弧度）。 */
export function tangentAt(points: Pt[], s: number): number {
  let remaining = Math.max(0, s);
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = dist(a, b);
    if (remaining <= seg || i === points.length - 1) return Math.atan2(b.y - a.y, b.x - a.x);
    remaining -= seg;
  }
  return Math.PI / 2;
}

/**
 * 点 p 到折线的投影：返回弧长 s、最近点、横向偏移（右为正）、法向点。
 */
export function projectToPolyline(points: Pt[], p: Pt): { s: number; closest: Pt; lateral: number } {
  let best = { s: 0, d: Infinity, closest: points[0] ?? { x: 0, y: 0 }, lateral: 0 };
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const seg2 = dx * dx + dy * dy;
    let t = seg2 === 0 ? 0 : ((p.x - a.x) * dx + (p.y - a.y) * dy) / seg2;
    t = Math.max(0, Math.min(1, t));
    const cx = a.x + dx * t;
    const cy = a.y + dy * t;
    const d = Math.hypot(p.x - cx, p.y - cy);
    if (d < best.d) {
      // 法向：切线逆时针 90°；lateral 正=左侧
      const nx = -dy;
      const ny = dx;
      const segLen = Math.sqrt(seg2) || 1;
      const lateral = ((p.x - cx) * nx + (p.y - cy) * ny) / segLen;
      best = { s: acc + t * segLen, d, closest: { x: cx, y: cy }, lateral };
    }
    acc += Math.sqrt(seg2);
  }
  return best;
}

/** 绕中心顺时针旋转 angleDeg 的坐标映射（raw -> corrected）。 */
export function rotatePoint(p: Pt, angleDeg: number, w: number, h: number): Pt {
  const cx = (w - 1) / 2;
  const cy = (h - 1) / 2;
  const a = (-angleDeg * Math.PI) / 180;
  const x = p.x - cx;
  const y = p.y - cy;
  return {
    x: x * Math.cos(a) - y * Math.sin(a) + cx,
    y: x * Math.sin(a) + y * Math.cos(a) + cy,
  };
}

/** corrected -> raw 的逆旋转。 */
export function unrotatePoint(p: Pt, angleDeg: number, w: number, h: number): Pt {
  return rotatePoint(p, -angleDeg, w, h);
}

/** 标准方向下的直泳道折线（top -> bottom）。 */
export function straightLane(x: number, top: number, bottom: number, samples = 60): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    out.push({ x, y: top + (bottom - top) * t });
  }
  return out;
}

/**
 * “微笑”弯曲车道：越靠近点样孔两端越被拉向外侧，中央弧长更长。
 * v(y) = amp * 4*(t*(1-t))  的 x 偏移；不同车道 amp 随列放大。
 */
export function smileLane(x0: number, top: number, bottom: number, amp: number, samples = 80): Pt[] {
  const out: Pt[] = [];
  for (let i = 0; i <= samples; i++) {
    const t = i / samples;
    const y = top + (bottom - top) * t;
    const offset = amp * 4 * t * (1 - t);
    out.push({ x: x0 + offset, y });
  }
  return out;
}

export function makePixelPoint(
  p: Pt,
  imageVersionId: string,
  transformChain: string[],
  basis: PixelPoint['basis'],
  unit: PixelPoint['unit'] = 'px',
): PixelPoint {
  return { x: p.x, y: p.y, unit, imageVersionId, transformChain, basis };
}

export function transformSummary(transforms: Transform[]): string {
  return transforms.map((t) => t.id).join('<-') || 'identity';
}

export function asQtyLen(value: number, basis: string): Quantity {
  return q(value, 'px', basis);
}
