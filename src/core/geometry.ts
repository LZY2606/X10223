import type { Point, Rotation } from "./types";

/** 把 raw 帧坐标点按拍摄方向顺时针旋转到 canonical 帧 */
export function toCanonical(p: Point, width: number, height: number, rotation: Rotation): Point {
  switch (rotation) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: height - 1 - p.y, y: p.x };
    case 180:
      return { x: width - 1 - p.x, y: height - 1 - p.y };
    case 270:
      return { x: p.y, y: width - 1 - p.x };
  }
}

export function canonicalSize(width: number, height: number, rotation: Rotation): { w: number; h: number } {
  return rotation === 90 || rotation === 270 ? { w: height, h: width } : { w: width, h: height };
}

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 折线累计弧长（像素） */
export function arcLengths(poly: Point[]): number[] {
  const lens = [0];
  for (let i = 1; i < poly.length; i++) lens.push(lens[i - 1]! + dist(poly[i - 1]!, poly[i]!));
  return lens;
}

/** 点到折线：返回弧长 s 与最近点 */
export function projectToCurve(p: Point, poly: Point[]): { s: number; point: Point; lateral: number } {
  let best = { s: 0, point: poly[0]!, lateral: Infinity };
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    const t = len2 === 0 ? 0 : Math.min(1, Math.max(0, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
    const q = { x: a.x + vx * t, y: a.y + vy * t };
    const lateral = Math.hypot(p.x - q.x, p.y - q.y);
    const s = acc + Math.hypot(q.x - a.x, q.y - a.y);
    if (lateral < best.lateral) best = { s, point: q, lateral };
    acc += Math.hypot(vx, vy);
  }
  return best;
}

/** 给定弧长在折线上取点 */
export function pointAtS(poly: Point[], s: number): Point | null {
  if (poly.length === 0) return null;
  if (s <= 0) return poly[0]!;
  let acc = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    const seg = dist(a, b);
    if (acc + seg >= s) {
      const t = seg === 0 ? 0 : (s - acc) / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    acc += seg;
  }
  return poly[poly.length - 1]!;
}

/** 微笑弯曲检验：同一 canonical 高度 y 在两条泳道上的弧长差 */
export function sAtCanonicalY(poly: Point[], y: number): number | null {
  if (poly.length === 0) return null;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!;
    const b = poly[i]!;
    if ((a.y <= y && b.y >= y) || (b.y <= y && a.y >= y)) {
      const t = b.y === a.y ? 0 : (y - a.y) / (b.y - a.y);
      const x = a.x + (b.x - a.x) * t;
      const before = arcLengths(poly.slice(0, i));
      return before[before.length - 1]! + Math.hypot(x - a.x, y - a.y);
    }
  }
  return null;
}
