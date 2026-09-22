import type { LaneAnnotation, PxPoint } from './types';

export function polylineLength(points: PxPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
  }
  return len;
}

export interface Projected {
  s: number;
  /** 最近中心线上的点。 */
  nearest: PxPoint;
  /** 到中心线距离（px），用于判断是否在道内。 */
  distance: number;
  segmentIndex: number;
}

/** 将原图像素点投影到泳道折线：返回自起点弧长 s 与最近点。 */
export function projectToLane(lane: LaneAnnotation, p: PxPoint): Projected {
  const pts = lane.centerline.points;
  let best: Projected | null = null;
  let sAcc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const segLen = Math.hypot(vx, vy);
    const ux = vx / segLen;
    const uy = vy / segLen;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * ux + (p.y - a.y) * uy) / segLen));
    const nx = a.x + t * vx;
    const ny = a.y + t * vy;
    const d = Math.hypot(p.x - nx, p.y - ny);
    const s = sAcc + t * segLen;
    if (!best || d < best.distance) {
      best = { s, nearest: { x: nx, y: ny, frame: 'original-pixel' }, distance: d, segmentIndex: i };
    }
    sAcc += segLen;
  }
  if (!best) {
    return { s: 0, nearest: pts[0] ?? { x: p.x, y: p.y, frame: 'original-pixel' }, distance: NaN, segmentIndex: 0 };
  }
  return best;
}

/** 中心线在弧长 s 处的点与切线。 */
export function pointAtArcLength(
  points: PxPoint[],
  s: number,
): { point: PxPoint; tangentX: number; tangentY: number } {
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + seg >= s || i === points.length - 2) {
      const t = seg === 0 ? 0 : Math.max(0, Math.min(1, (s - acc) / seg));
      return {
        point: { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y), frame: 'original-pixel' },
        tangentX: (b.x - a.x) / seg,
        tangentY: (b.y - a.y) / seg,
      };
    }
    acc += seg;
  }
  const last = points[points.length - 1]!;
  return { point: last, tangentX: 0, tangentY: 1 };
}

/** 折线的“微笑”指标：中部相对弦线的最大横向偏移（px）。 */
export function curvatureSmile(lane: LaneAnnotation): number {
  const pts = lane.centerline.points;
  if (pts.length < 2) return 0;
  const first = pts[0]!;
  const last = pts[pts.length - 1]!;
  let max = 0;
  for (const p of pts) {
    const d =
      Math.abs((last.y - first.y) * p.x - (last.x - first.x) * p.y + last.x * first.y - last.y * first.x) /
      Math.hypot(last.y - first.y, last.x - first.x);
    if (d > max) max = d;
  }
  return max;
}
