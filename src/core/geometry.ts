import type { PixelPoint } from '../shared/types.js';

export function pt(x: number, y: number, coordinateSystem: string): PixelPoint {
  return { x, y, unit: 'pixel', coordinateSystem };
}

/** 折线总弧长。 */
export function polylineLength(points: PixelPoint[]): number {
  let len = 0;
  for (let i = 1; i < points.length; i++) {
    len += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
  }
  return len;
}

/** 沿折线在弧长 s 处取点；返回点与该点切线方向。 */
export function sampleAt(points: PixelPoint[], s: number): { point: PixelPoint; tangent: { dx: number; dy: number } } {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + seg >= s || i === points.length - 1) {
      const t = seg === 0 ? 0 : Math.min(1, Math.max(0, (s - acc) / seg));
      const cs = a.unit ? a : { unit: 'pixel' as const };
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t, unit: 'pixel', coordinateSystem: (a as PixelPoint).coordinateSystem },
        tangent: { dx: (b.x - a.x) / (seg || 1), dy: (b.y - a.y) / (seg || 1) },
      };
    }
    acc += seg;
  }
  const last = points[points.length - 1];
  return { point: { ...last }, tangent: { dx: 0, dy: 1 } };
}

/** 点到折线的弧长投影（返回最近弧长与横向偏移）。 */
export function projectToCurve(
  points: PixelPoint[],
  p: { x: number; y: number },
): { s: number; lateral: number; x: number; y: number } {
  let best = { dist2: Infinity, s: 0, lateral: 0, x: 0, y: 0 };
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1];
    const b = points[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const seg2 = vx * vx + vy * vy || 1;
    const t = Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / seg2));
    const qx = a.x + vx * t;
    const qy = a.y + vy * t;
    const d2 = (p.x - qx) ** 2 + (p.y - qy) ** 2;
    if (d2 < best.dist2) {
      const sBase = acc + Math.sqrt(seg2) * t;
      // 横向偏移：点相对切线的垂直分量
      const seg = Math.sqrt(seg2);
      const nx = -vy / seg;
      const ny = vx / seg;
      best = {
        dist2: d2,
        s: sBase,
        lateral: (p.x - qx) * nx + (p.y - qy) * ny,
        x: qx,
        y: qy,
      };
    }
    acc += Math.sqrt(seg2);
  }
  return best;
}

/** 生成一条可选“微笑”弯曲的泳道中心线折线。 */
export function buildLaneCurve(
  xCenter: number,
  y0: number,
  y1: number,
  kind: 'straight' | 'smile',
  curvature: number,
  coordinateSystem: string,
  steps = 60,
): PixelPoint[] {
  const points: PixelPoint[] = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = y0 + (y1 - y0) * t;
    let x = xCenter;
    if (kind === 'smile') {
      // 中间向下（迁移更远）造成的横向位移表达：x 随 t 的对称弯曲
      x = xCenter + curvature * 4 * t * (1 - t) * 0; // 占位；真正的微笑用 y 偏移
    }
    points.push(pt(x, y, coordinateSystem));
  }
  if (kind === 'smile') {
    // 微笑：泳道中央迁移滞后/超前，沿弧长在 y 上叠加对称偏移
    return points.map((p, i) => {
      const t = i / steps;
      const bend = curvature * 4 * t * (1 - t); // 中部最大
      return pt(p.x, p.y + bend, coordinateSystem);
    });
  }
  return points;
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, v));
}
