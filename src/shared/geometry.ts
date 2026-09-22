import type { CoordFrame, PixelPoint } from './types';
import type { GrayImage } from './png';

export interface XY {
  x: number;
  y: number;
}

export function dist(a: XY, b: XY): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

export interface Polyline {
  points: XY[];
  /** 每段起点的累计弧长 */
  cumS: number[];
  totalS: number;
}

/** 折线弧长参数化：弯曲泳道用脊线 s(px) 作为迁移坐标，而不是全局 y */
export function buildPolyline(points: PixelPoint[] | XY[]): Polyline {
  if (points.length < 2) throw new Error('GEOMETRY_POLYLINE_NEEDS_2_POINTS');
  const cumS = [0];
  for (let i = 1; i < points.length; i += 1) {
    cumS.push(cumS[i - 1] + dist(points[i - 1], points[i]));
  }
  return { points: points.map((p) => ({ x: p.x, y: p.y })), cumS, totalS: cumS[cumS.length - 1] };
}

/** 按弧长 s 取折线上的位置与切线方向 */
export function pointAtS(line: Polyline, s: number): { x: number; y: number; tangent: XY } {
  const target = Math.max(0, Math.min(line.totalS, s));
  for (let i = 1; i < line.points.length; i += 1) {
    if (target <= line.cumS[i] + 1e-9 || i === line.points.length - 1) {
      const start = line.cumS[i - 1];
      const segLen = line.cumS[i] - start || 1;
      const t = Math.max(0, Math.min(1, (target - start) / segLen));
      const a = line.points[i - 1];
      const b = line.points[i];
      return {
        x: a.x + (b.x - a.x) * t,
        y: a.y + (b.y - a.y) * t,
        tangent: { x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen }
      };
    }
  }
  const last = line.points[line.points.length - 1];
  return { x: last.x, y: last.y, tangent: { x: 0, y: 1 } };
}

export function midSpine(left: PixelPoint[], right: PixelPoint[]): XY[] {
  const n = Math.min(left.length, right.length);
  const out: XY[] = [];
  for (let i = 0; i < n; i += 1) out.push({ x: (left[i].x + right[i].x) / 2, y: (left[i].y + right[i].y) / 2 });
  return out;
}

/** 沿弯曲脊线做横截面平均采样，返回按弧长排列的强度剖面 */
export function sampleProfile(
  image: GrayImage,
  spinePoints: XY[],
  halfWidthPx: number,
  stepPx = 2
): { s: number; x: number; y: number; intensity: number }[] {
  const line = buildPolyline(spinePoints);
  const out: { s: number; x: number; y: number; intensity: number }[] = [];
  for (let s = 0; s <= line.totalS; s += stepPx) {
    const p = pointAtS(line, s);
    const nx = -p.tangent.y;
    const ny = p.tangent.x;
    let sum = 0;
    let count = 0;
    for (let w = -halfWidthPx; w <= halfWidthPx; w += 1) {
      const x = Math.round(p.x + nx * w);
      const y = Math.round(p.y + ny * w);
      if (x >= 0 && y >= 0 && x < image.width && y < image.height) {
        sum += image.pixels[y * image.width + x];
        count += 1;
      }
    }
    out.push({ s, x: p.x, y: p.y, intensity: count > 0 ? sum / count : 0 });
  }
  return out;
}

/**
 * 拍摄方向坐标变换。
 * raw 帧中的 (x,y) 经过顺时针旋转修正后映射到 corrected 帧。
 */
export function rotatePoint(
  p: XY,
  deg: 0 | 90 | 180 | 270,
  rawWidth: number,
  rawHeight: number
): XY & { width: number; height: number } {
  if (deg === 0) return { x: p.x, y: p.y, width: rawWidth, height: rawHeight };
  if (deg === 90) return { x: rawHeight - 1 - p.y, y: p.x, width: rawHeight, height: rawWidth };
  if (deg === 180) return { x: rawWidth - 1 - p.x, y: rawHeight - 1 - p.y, width: rawWidth, height: rawHeight };
  return { x: p.y, y: rawWidth - 1 - p.x, width: rawHeight, height: rawWidth };
}

export function frameSize(frame: CoordFrame): { width: number; height: number } {
  const rotated = frame.rotationDeg === 90 || frame.rotationDeg === 270;
  return {
    width: rotated ? frame.heightPx : frame.widthPx,
    height: rotated ? frame.widthPx : frame.heightPx
  };
}

/** 一维高斯 */
export function gaussian(x: number, mu: number, sigma: number, amp: number): number {
  const z = (x - mu) / sigma;
  return amp * Math.exp(-0.5 * z * z);
}

/** 简单背景估计：滑窗最小值基线（电泳剖面常用） */
export function rollingBaseline(values: number[], window: number): number[] {
  const out: number[] = [];
  const half = Math.floor(window / 2);
  for (let i = 0; i < values.length; i += 1) {
    let min = Infinity;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j += 1) {
      if (values[j] < min) min = values[j];
    }
    out.push(min === Infinity ? 0 : min);
  }
  return out;
}
