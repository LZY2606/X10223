/**
 * 几何与坐标基准：raw <-> canonical 变换、弯曲泳道弧长、点到曲线投影。
 * 关键规则：微笑/皱眉弯曲时，同一像素高度 y 不代表同一分子量 ——
 * 校准与比较一律使用沿泳道中心线的弧长 s（canonical 像素基准）。
 */
import type { OrientationMaterial, Point, SourcedPoint } from './types';

export interface FrameDims {
  width: number;
  height: number;
}

export function canonicalDims(raw: FrameDims, orientation: OrientationMaterial): FrameDims {
  return orientation.rotationDeg === 90 || orientation.rotationDeg === 270
    ? { width: raw.height, height: raw.width }
    : { width: raw.width, height: raw.height };
}

/** raw 像素坐标 -> canonical（迁移向下）。 */
export function toCanonical(p: Point, raw: FrameDims, o: OrientationMaterial): Point {
  let { x, y } = p;
  const w = raw.width;
  const h = raw.height;
  if (o.flipH) x = w - 1 - x;
  if (o.flipV) y = h - 1 - y;
  switch (o.rotationDeg) {
    case 0:
      return { x, y };
    case 90:
      return { x: h - 1 - y, y: x };
    case 180:
      return { x: w - 1 - x, y: h - 1 - y };
    case 270:
      return { x: y, y: w - 1 - x };
  }
}

export function toRaw(p: Point, raw: FrameDims, o: OrientationMaterial): Point {
  let { x, y } = p;
  switch (o.rotationDeg) {
    case 0:
      break;
    case 90:
      x = p.y;
      y = raw.height - 1 - p.x;
      break;
    case 180:
      x = raw.width - 1 - p.x;
      y = raw.height - 1 - p.y;
      break;
    case 270:
      x = raw.width - 1 - p.y;
      y = p.x;
      break;
  }
  if (o.flipV) y = raw.height - 1 - y;
  if (o.flipH) x = raw.width - 1 - x;
  return { x, y };
}

/** 折线累积弧长（像素）。 */
export function cumulativeLengths(points: Point[]): number[] {
  const out = new Array<number>(points.length).fill(0);
  for (let i = 1; i < points.length; i++) {
    const dx = points[i]!.x - points[i - 1]!.x;
    const dy = points[i]!.y - points[i - 1]!.y;
    out[i] = out[i - 1]! + Math.hypot(dx, dy);
  }
  return out;
}

/** 把点投影到折线，返回弧长参数 s 与垂足。 */
export function projectToCurve(point: Point, polyline: Point[]): { s: number; foot: Point; dist: number } {
  let best = { s: 0, foot: polyline[0]!, dist: Infinity };
  let segStart = 0;
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i]!;
    const b = polyline[i + 1]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const segLen2 = vx * vx + vy * vy;
    let t = segLen2 === 0 ? 0 : ((point.x - a.x) * vx + (point.y - a.y) * vy) / segLen2;
    t = Math.max(0, Math.min(1, t));
    const fx = a.x + t * vx;
    const fy = a.y + t * vy;
    const d = Math.hypot(point.x - fx, point.y - fy);
    if (d < best.dist) {
      best = { s: segStart + t * Math.sqrt(segLen2), foot: { x: fx, y: fy }, dist: d };
    }
    segStart += Math.sqrt(segLen2);
  }
  return best;
}

/** 沿折线按弧长 s 取点。 */
export function pointAtLength(polyline: Point[], lengths: number[], s: number): Point {
  if (polyline.length === 0) throw new Error('空折线');
  if (s <= 0) return polyline[0]!;
  if (s >= lengths[lengths.length - 1]!) return polyline[polyline.length - 1]!;
  for (let i = 1; i < lengths.length; i++) {
    if (s <= lengths[i]!) {
      const l0 = lengths[i - 1]!;
      const l1 = lengths[i]!;
      const t = (s - l0) / (l1 - l0 || 1);
      return {
        x: polyline[i - 1]!.x + t * (polyline[i]!.x - polyline[i - 1]!.x),
        y: polyline[i - 1]!.y + t * (polyline[i]!.y - polyline[i - 1]!.y)
      };
    }
  }
  return polyline[polyline.length - 1]!;
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function isSourced(p: Point): p is SourcedPoint {
  return (p as SourcedPoint).source !== undefined;
}
