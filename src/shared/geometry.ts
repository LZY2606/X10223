// 泳道几何：弯曲中心线上的弧长坐标 s。
// 关键领域判断 R-SMILE-LOCAL-RULER 的数学基础：同一图像高度 y 不等于同一分子量，
// 只有同一泳道上的弧长 s 才可与迁移距离对应。
import type { PixelPoint, CoordinateBasis } from './types.ts';

export interface DenseLane {
  basis: CoordinateBasis;
  points: PixelPoint[];      // 密采样中心线
  cum: number[];             // 各点累计弧长 pixel
  total: number;
}

export function dist(a: PixelPoint, b: PixelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function densify(control: PixelPoint[], basis: CoordinateBasis, stepPx = 1): DenseLane {
  if (control.length < 2) throw new Error('lane needs >=2 control points');
  const points: PixelPoint[] = [];
  const cum: number[] = [0];
  for (let i = 0; i < control.length - 1; i++) {
    const a = control[i]!;
    const b = control[i + 1]!;
    const seg = dist(a, b);
    const n = Math.max(1, Math.round(seg / stepPx));
    for (let k = 0; k < n; k++) {
      const t = k / n;
      points.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, basis });
      if (points.length > 1) cum.push(cum[cum.length - 1]! + dist(points[points.length - 2]!, points[points.length - 1]!));
    }
  }
  const last = control[control.length - 1]!;
  points.push({ x: last.x, y: last.y, basis });
  cum.push(cum[cum.length - 1]! + dist(points[points.length - 2]!, points[points.length - 1]!));
  return { basis, points, cum, total: cum[cum.length - 1]! };
}

/** 弧长 s 处的中心线点与切线角。 */
export function pointAt(lane: DenseLane, s: number): { point: PixelPoint; angle: number; within: boolean } {
  const { points, cum, total, basis } = lane;
  const clamped = Math.max(0, Math.min(total, s));
  let lo = 0;
  let hi = cum.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cum[mid]! < clamped) lo = mid + 1;
    else hi = mid;
  }
  const j = Math.max(1, lo);
  const s0 = cum[j - 1]!;
  const s1 = cum[j]!;
  const t = s1 === s0 ? 0 : (clamped - s0) / (s1 - s0);
  const p0 = points[j - 1]!;
  const p1 = points[j] ?? p0;
  return {
    point: { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t, basis },
    angle: Math.atan2(p1.y - p0.y, p1.x - p0.x),
    within: s >= 0 && s <= total
  };
}

/** 把条带中心投影到中心线上，返回弧长 s、法向偏移与投影点。 */
export function projectToLane(lane: DenseLane, p: PixelPoint): { s: number; offset: number; foot: PixelPoint } {
  let best = { d: Infinity, s: 0, foot: lane.points[0]! };
  for (let i = 0; i < lane.points.length - 1; i++) {
    const a = lane.points[i]!;
    const b = lane.points[i + 1]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const fx = a.x + vx * t;
    const fy = a.y + vy * t;
    const d = Math.hypot(p.x - fx, p.y - fy);
    if (d < best.d) best = { d, s: lane.cum[i]! + Math.sqrt(len2) * t, foot: { x: fx, y: fy, basis: lane.basis } };
  }
  return { s: best.s, offset: best.d, foot: best.foot };
}

/** 诊断用：条带中心相对泳道宽度是否越界（pixel）。 */
export function withinLaneWidth(offset: number, widthPx: number): boolean {
  return offset <= widthPx / 2 + 0.5;
}
