// 像素几何：方向归一（仅派生层）、折线弧长、最近点投影。
// 坐标基准：已存储栅格图像左上角，单位 px。
import type { OrientationMaterial, PixelPoint } from "./types";

export function dist(a: PixelPoint, b: PixelPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 旋转归一：把已存储栅格坐标 -> 审阅坐标（0deg 为点样孔在上方）。 */
export function applyOrientation(
  p: PixelPoint,
  imageWidth: number,
  imageHeight: number,
  orientation: Pick<OrientationMaterial, "rotationDeg">
): PixelPoint {
  switch (orientation.rotationDeg) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      // 顺时针 90：(x,y)->(H-1-y, x)
      return { x: imageHeight - 1 - p.y, y: p.x };
    case 180:
      return { x: imageWidth - 1 - p.x, y: imageHeight - 1 - p.y };
    case 270:
      return { x: p.y, y: imageWidth - 1 - p.x };
  }
}

export function orientedImageSize(
  width: number,
  height: number,
  rotationDeg: 0 | 90 | 180 | 270
): { width: number; height: number } {
  return rotationDeg === 90 || rotationDeg === 270
    ? { width: height, height: width }
    : { width, height };
}

interface SegmentProjection {
  s: number; // 沿折线累计弧长（自上而下）
  lateral: number; // 横向有符号偏移（左负右正）
  index: number;
}

/**
 * 把点投影到折线上，返回沿弧长 s 与横向偏移。
 * 微笑泳道：同一条带的“分子量位置”由沿中心线的弧长决定，而非图像 y。
 */
export function projectToPolyline(points: PixelPoint[], p: PixelPoint): SegmentProjection {
  if (points.length === 0) {
    throw new Error("empty polyline");
  }
  let best: SegmentProjection = { s: 0, lateral: Infinity, index: 0 };
  let bestDistance = Infinity;
  let cumulative = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const segLen = Math.hypot(vx, vy);
    if (segLen === 0) continue;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / (segLen * segLen)));
    const qx = a.x + t * vx;
    const qy = a.y + t * vy;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bestDistance) {
      bestDistance = d;
      const normalX = -vy / segLen;
      const normalY = vx / segLen;
      best = {
        s: cumulative + t * segLen,
        lateral: (p.x - qx) * normalX + (p.y - qy) * normalY,
        index: i
      };
    }
    cumulative += segLen;
  }
  if (points.length === 1) {
    return { s: 0, lateral: dist(p, points[0]), index: 0 };
  }
  return best;
}

/** 折线上指定弧长处的点与切线。 */
export function pointAtArcLength(
  points: PixelPoint[],
  s: number
): { point: PixelPoint; tangent: PixelPoint } {
  let cumulative = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (segLen === 0) continue;
    if (s <= cumulative + segLen || i === points.length - 2) {
      const t = segLen === 0 ? 0 : Math.max(0, Math.min(1, (s - cumulative) / segLen));
      return {
        point: { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) },
        tangent: { x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen }
      };
    }
    cumulative += segLen;
  }
  const last = points[points.length - 1];
  return { point: { ...last }, tangent: { x: 0, y: 1 } };
}
