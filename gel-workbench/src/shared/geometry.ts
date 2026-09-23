import type { Point, Polyline } from "./types.js";

export interface Pt {
  x: number;
  y: number;
}

export function numPoint(p: Point): Pt {
  if (typeof p.x.value !== "number" || typeof p.y.value !== "number") {
    throw new Error("geometry.point_without_numeric_coordinate");
  }
  return { x: p.x.value, y: p.y.value };
}

/** 顺时针旋转（与拍摄方向 orientationDeg 对应），坐标仍在原图像素帧 */
export function rotateCw(p: Pt, deg: 0 | 90 | 180 | 270, w: number, h: number): Pt {
  switch (deg) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: h - p.y, y: p.x };
    case 180:
      return { x: w - p.x, y: h - p.y };
    case 270:
      return { x: p.y, y: w - p.x };
  }
}

export function rotatedSize(w: number, h: number, deg: 0 | 90 | 180 | 270) {
  return deg === 90 || deg === 270 ? { w: h, h: w } : { w, h };
}

/** 折线累计长度（px） */
export function polylineLength(pl: Polyline): number {
  const pts = pl.points.map(numPoint);
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 以弧长 s（px）沿折线取点 */
export function pointAtArcLength(pl: Polyline, s: number): { point: Pt; tangent: Pt } {
  const pts = pl.points.map(numPoint);
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const seg = dist(a, b);
    if (acc + seg >= s - 1e-9) {
      const t = seg === 0 ? 0 : Math.min(1, Math.max(0, (s - acc) / seg));
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        tangent: seg === 0 ? { x: 0, y: 1 } : { x: (b.x - a.x) / seg, y: (b.y - a.y) / seg },
      };
    }
    acc += seg;
  }
  const last = pts[pts.length - 1];
  return { point: last, tangent: { x: 0, y: 1 } };
}

/** 两条边界折线的逐样本中心线与法向半宽（用于“微笑”弯曲 lane） */
export function centerline(left: Polyline, right: Polyline, samples = 80) {
  const len = Math.min(polylineLength(left), polylineLength(right));
  const out: { s: number; center: Pt; normal: Pt; halfWidth: number }[] = [];
  for (let i = 0; i <= samples; i++) {
    const s = (len * i) / samples;
    const l = pointAtArcLength(left, s);
    const r = pointAtArcLength(right, s);
    const center = { x: (l.point.x + r.point.x) / 2, y: (l.point.y + r.point.y) / 2 };
    const tangent = l.tangent;
    const normal = { x: -tangent.y, y: tangent.x };
    out.push({ s, center, normal, halfWidth: dist(l.point, r.point) / 2 });
  }
  return out;
}

/**
 * 将一个像素点投影到中心线：返回弧长 s（迁移坐标）与法向偏移。
 * 弯曲 lane 下，“同一 y”不等于“同一迁移量”——必须用弧长投影。
 */
export function projectToCenterline(
  p: Pt,
  spine: { s: number; center: Pt; normal: Pt; halfWidth: number }[]
): { s: number; lateralOffset: number; within: boolean } {
  let best = { s: 0, d2: Infinity, lateralOffset: 0, halfWidth: 0 };
  for (let i = 0; i < spine.length; i++) {
    const node = spine[i];
    const dx = p.x - node.center.x;
    const dy = p.y - node.center.y;
    const lateral = dx * node.normal.x + dy * node.normal.y;
    const along = dx * (-node.normal.y) + dy * node.normal.x;
    const d2 = lateral * lateral;
    if (d2 < best.d2) best = { s: node.s + along, d2, lateralOffset: lateral, halfWidth: node.halfWidth };
  }
  return {
    s: best.s,
    lateralOffset: best.lateralOffset,
    within: Math.abs(best.lateralOffset) <= best.halfWidth + 2,
  };
}

export function clamp(v: number, lo: number, hi: number) {
  return Math.max(lo, Math.min(hi, v));
}
