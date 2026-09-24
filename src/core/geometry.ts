import type { Point } from './types.ts';

/** 二次贝塞尔：起点 p0、控制点 pc、终点 p2。弯曲泳道用该曲线表达“微笑”。 */
export function quadBezier(p0: Point, pc: Point, p2: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * p0.x + 2 * u * t * pc.x + t * t * p2.x,
    y: u * u * p0.y + 2 * u * t * pc.y + t * t * p2.y,
    unit: 'px',
  };
}

/**
 * 泳道中心线：直线时 2 点，弯曲时 3 点（二次贝塞尔）。
 * 迁移方向自上而下：s=0 在顶部（小分子量跑得快，位于底部，故 MW 随 s 增大而减小）。
 */
export function centerlinePoints(points: Point[], samples = 240): Point[] {
  if (points.length === 3) {
    return Array.from({ length: samples + 1 }, (_, i) => quadBezier(points[0], points[1], points[2], i / samples));
  }
  if (points.length === 2) {
    return Array.from({ length: samples + 1 }, (_, i) => {
      const t = i / samples;
      return { x: points[0].x + (points[1].x - points[0].x) * t, y: points[0].y + (points[1].y - points[0].y) * t, unit: 'px' as const };
    });
  }
  return points;
}

export interface ArcTable {
  pts: Point[];
  cum: number[]; // 累计弧长（像素）
  total: number;
}

export function buildArcTable(points: Point[], samples = 240): ArcTable {
  const pts = centerlinePoints(points, samples);
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return { pts, cum, total: cum[cum.length - 1] };
}

export function pointAtArc(table: ArcTable, s: number): Point {
  const { pts, cum } = table;
  for (let i = 1; i < cum.length; i++) {
    if (s <= cum[i]) {
      const span = cum[i] - cum[i - 1] || 1;
      const t = (s - cum[i - 1]) / span;
      return { x: pts[i - 1].x + (pts[i].x - pts[i - 1].x) * t, y: pts[i - 1].y + (pts[i].y - pts[i - 1].y) * t, unit: 'px' };
    }
  }
  return pts[pts.length - 1];
}

/** 将任意像素点投影到泳道曲线，返回最近点弧长、像素距离与最近点。这是“同高度≠同分子量”的关键。 */
export function projectToLane(table: ArcTable, p: Point): { arc: number; normalDistancePx: number; closest: Point } {
  let best = { arc: 0, d: Infinity, closest: table.pts[0] };
  for (let i = 0; i < table.pts.length; i++) {
    const d = Math.hypot(table.pts[i].x - p.x, table.pts[i].y - p.y);
    if (d < best.d) best = { arc: table.cum[i], d, closest: table.pts[i] };
  }
  return { arc: best.arc, normalDistancePx: best.d, closest: best.closest };
}

export function rotatePoint(p: Point, deg: 90 | 180 | 270, width: number, height: number): Point {
  if (deg === 90) return { x: height - p.y, y: p.x, unit: 'px' };
  if (deg === 180) return { x: width - p.x, y: height - p.y, unit: 'px' };
  return { x: p.y, y: width - p.x, unit: 'px' }; // 270
}
