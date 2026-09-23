import type { Orientation, PixelPoint } from './types.js';

export interface Size {
  width: number;
  height: number;
}

/** 原图方向 -> 修正方向('up') 的旋转次数（顺时针 90deg） */
export function rotationQuarterTurns(from: Orientation, to: Orientation): number {
  const order: Orientation[] = ['up', 'right', 'down', 'left'];
  return (order.indexOf(to) - order.indexOf(from) + 4) % 4;
}

export function rotatedSize(size: Size, turns: number): Size {
  return turns % 2 === 0 ? size : { width: size.height, height: size.width };
}

/**
 * 修正帧 -> 原始帧 的像素映射。
 * 修正帧：把拍摄方向转到 'up' 后的坐标。
 */
export function correctedToRaw(
  x: number,
  y: number,
  native: Size,
  turns: number,
): { rx: number; ry: number } {
  const { width: W, height: H } = rotatedSize(native, turns);
  switch (turns) {
    case 0:
      return { rx: x, ry: y };
    case 1: // 顺时针 90：raw.x = y, raw.y = W-1-x
      return { rx: y, ry: W - 1 - x };
    case 2:
      return { rx: W - 1 - x, ry: H - 1 - y };
    case 3:
      return { rx: H - 1 - y, ry: x };
    default:
      return { rx: x, ry: y };
  }
}

export function rawToCorrected(
  rx: number,
  ry: number,
  native: Size,
  turns: number,
): { x: number; y: number } {
  const { width: W, height: H } = rotatedSize(native, turns);
  switch (turns) {
    case 0:
      return { x: rx, y: ry };
    case 1:
      return { x: W - 1 - ry, y: rx };
    case 2:
      return { x: W - 1 - rx, y: H - 1 - ry };
    case 3:
      return { x: ry, y: H - 1 - rx };
    default:
      return { x: rx, y: ry };
  }
}

export function makePixelPoint(
  x: number,
  y: number,
  native: Size,
  turns: number,
): PixelPoint {
  const raw = correctedToRaw(x, y, native, turns);
  return { x, y, rx: raw.rx, ry: raw.ry, frame: 'corrected' };
}

// ---------- 泳道中心线（Catmull-Rom 插值 + 弧长） ----------

export function catmullRom(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const t2 = t * t;
  const t3 = t2 * t;
  return 0.5 * (2 * p1 + (-p0 + p2) * t + (2 * p0 - 5 * p1 + 4 * p2 - p3) * t2 + (-p0 + 3 * p1 - 3 * p2 + p3) * t3);
}

export interface SampledCurve {
  points: { x: number; y: number }[];
  cum: number[];
  totalLength: number;
}

export function sampleCurve(control: { x: number; y: number }[], samplesPerSeg = 12): SampledCurve {
  const pts: { x: number; y: number }[] = [];
  const cps = control.length >= 2 ? control : [control[0], control[0]];
  for (let i = 0; i < cps.length - 1; i++) {
    const p0 = cps[Math.max(0, i - 1)];
    const p1 = cps[i];
    const p2 = cps[i + 1];
    const p3 = cps[Math.min(cps.length - 1, i + 2)];
    for (let t = 0; t < samplesPerSeg; t++) {
      const u = t / samplesPerSeg;
      pts.push({ x: catmullRom(p0.x, p1.x, p2.x, p3.x, u), y: catmullRom(p0.y, p1.y, p2.y, p3.y, u) });
    }
  }
  pts.push({ ...cps[cps.length - 1] });
  const cum = [0];
  for (let i = 1; i < pts.length; i++) {
    cum.push(cum[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  }
  return { points: pts, cum, totalLength: cum[cum.length - 1] || 0 };
}

/** 点到曲线的最近点索引与弧长 */
export function projectToCurve(
  curve: SampledCurve,
  p: { x: number; y: number },
): { arc: number; x: number; y: number; index: number; lateral: number } {
  let best = 0;
  let bestD = Infinity;
  for (let i = 0; i < curve.points.length; i++) {
    const d = (curve.points[i].x - p.x) ** 2 + (curve.points[i].y - p.y) ** 2;
    if (d < bestD) {
      bestD = d;
      best = i;
    }
  }
  const cp = curve.points[best];
  const before = curve.points[Math.max(0, best - 1)];
  const after = curve.points[Math.min(curve.points.length - 1, best + 1)];
  const tx = after.x - before.x;
  const ty = after.y - before.y;
  const tl = Math.hypot(tx, ty) || 1;
  const lateral = ((p.x - cp.x) * tx + (p.y - cp.y) * ty) / tl;
  return { arc: curve.cum[best], x: cp.x, y: cp.y, index: best, lateral };
}

export function pointAtArc(curve: SampledCurve, arc: number): { x: number; y: number } {
  const c = curve.cum;
  if (arc <= 0) return { ...curve.points[0] };
  if (arc >= curve.totalLength) return { ...curve.points[curve.points.length - 1] };
  let lo = 0;
  let hi = c.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (c[mid] < arc) lo = mid + 1;
    else hi = mid;
  }
  const i = Math.max(1, lo);
  const a0 = c[i - 1];
  const a1 = c[i];
  const t = (arc - a0) / (a1 - a0 || 1);
  return {
    x: curve.points[i - 1].x + (curve.points[i].x - curve.points[i - 1].x) * t,
    y: curve.points[i - 1].y + (curve.points[i].y - curve.points[i - 1].y) * t,
  };
}
