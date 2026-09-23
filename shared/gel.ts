// 几何与证据规则：坐标基变换、泳道弯曲校正、轮廓重叠。
// 纯函数，服务端引擎与测试直接调用。

import type { PixelBasis } from './types.js';

/** 采集坐标 → 规范坐标（orientation=0 的分析基）。 */
export function toCanonical(x: number, y: number, basis: PixelBasis): { x: number; y: number } {
  switch (basis.orientation) {
    case 0: return { x, y };
    case 90: return { x: y, y: basis.width - 1 - x };
    case 180: return { x: basis.width - 1 - x, y: basis.height - 1 - y };
    case 270: return { x: basis.height - 1 - y, y: x };
  }
}

/** 规范坐标 → 指定采集基（toCanonical 的逆变换）。 */
export function fromCanonical(x: number, y: number, basis: PixelBasis): { x: number; y: number } {
  switch (basis.orientation) {
    case 0: return { x, y };
    case 90: return { x: basis.width - 1 - y, y: x };
    case 180: return { x: basis.width - 1 - x, y: basis.height - 1 - y };
    case 270: return { x: y, y: basis.height - 1 - x };
  }
}

export interface Contour { x0: number; y0: number; x1: number; y1: number }

/** 轮廓盒变换到规范坐标。 */
export function contourToCanonical(c: Contour, basis: PixelBasis): Contour {
  const a = toCanonical(c.x0, c.y0, basis);
  const b = toCanonical(c.x1, c.y1, basis);
  return {
    x0: Math.min(a.x, b.x), y0: Math.min(a.y, b.y),
    x1: Math.max(a.x, b.x), y1: Math.max(a.y, b.y)
  };
}

/** 泳道弯曲（微笑）校正：lane 中心线给出 x 处的纵向偏移 dy，校正距离 d = y - dy(x)。 */
export function curveDy(centerline: { x: number; dy: number }[], x: number): number {
  if (centerline.length === 0) return 0;
  const pts = [...centerline].sort((p, q) => p.x - q.x);
  if (x <= pts[0].x) return pts[0].dy;
  if (x >= pts[pts.length - 1].x) return pts[pts.length - 1].dy;
  for (let i = 0; i < pts.length - 1; i++) {
    if (x >= pts[i].x && x <= pts[i + 1].x) {
      const t = (x - pts[i].x) / (pts[i + 1].x - pts[i].x || 1);
      return pts[i].dy + t * (pts[i + 1].dy - pts[i].dy);
    }
  }
  return pts[pts.length - 1].dy;
}

export function boxesOverlap(a: Contour, b: Contour, marginPx: number): boolean {
  return a.x0 - marginPx <= b.x1 && b.x0 - marginPx <= a.x1 &&
         a.y0 - marginPx <= b.y1 && b.y0 - marginPx <= a.y1;
}

/** 旋转灰度图 90° 顺时针（用于案例包生成旋转图像反例）。 */
export function rotate90CW(gray: Uint8Array, width: number, height: number): { data: Uint8Array; width: number; height: number } {
  const outW = height, outH = width;
  const out = new Uint8Array(outW * outH);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = height - 1 - y, ny = x;
      out[ny * outW + nx] = gray[y * width + x];
    }
  }
  return { data: out, width: outW, height: outH };
}
