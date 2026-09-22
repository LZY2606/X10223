import type { Point, Quant } from './types.js';

export const PX = (v: number): Quant => ({ value: v, unit: 'pixel' });

interface XY {
  x: number;
  y: number;
}

export function qnum(q: Quant): number {
  return q.value;
}

export function xy(p: Point): XY {
  return { x: p.x.value, y: p.y.value };
}

/** 折线段 */
export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  s0: number; // 起点累计弧长
  s1: number; // 终点累计弧长
}

export interface Polyline {
  points: XY[];
  segments: Segment[];
  length: number;
}

export function buildPolyline(points: Point[]): Polyline {
  const pts = points.map(xy);
  const segments: Segment[] = [];
  let s0 = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const s1 = s0 + Math.hypot(b.x - a.x, b.y - a.y);
    segments.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, s0, s1 });
    s0 = s1;
  }
  return { points: pts, segments, length: s0 };
}

/**
 * 把一个像素点投影到中心线，返回沿电泳方向的弧长 s 与投影坐标。
 * 这是“微笑”处理的关键：同一水平高度 y 在弯曲 lane 上对应不同 s，
 * 因此分子量必须按 lane 局部 s 而不是共享 y。
 */
export function projectToPolyline(
  poly: Polyline,
  px: number,
  py: number,
): { s: number; qx: number; qy: number; distance: number; within: boolean } {
  let best: { s: number; qx: number; qy: number; distance: number } | null = null;
  for (const seg of poly.segments) {
    const dx = seg.bx - seg.ax;
    const dy = seg.by - seg.ay;
    const len2 = dx * dx + dy * dy || 1e-9;
    let t = ((px - seg.ax) * dx + (py - seg.ay) * dy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = seg.ax + t * dx;
    const qy = seg.ay + t * dy;
    const distance = Math.hypot(px - qx, py - qy);
    if (!best || distance < best.distance) {
      best = { s: seg.s0 + t * (seg.s1 - seg.s0), qx, qy, distance };
    }
  }
  const r = best!;
  return { ...r, within: r.s >= -1e-6 && r.s <= poly.length + 1e-6 };
}

export function pointAtS(poly: Polyline, s: number): XY {
  for (const seg of poly.segments) {
    if (s <= seg.s1 || seg === poly.segments[poly.segments.length - 1]) {
      const t = (s - seg.s0) / Math.max(1e-9, seg.s1 - seg.s0);
      return { x: seg.ax + t * (seg.bx - seg.ax), y: seg.ay + t * (seg.by - seg.ay) };
    }
  }
  return poly.points[poly.points.length - 1]!;
}

/** 顺时针旋转 90/180/270 度：点坐标变换（在宽高 W,H 的图中）。 */
export function rotatePointCW(
  x: number,
  y: number,
  width: number,
  height: number,
  clockwiseDegrees: number,
): XY {
  const d = ((clockwiseDegrees % 360) + 360) % 360;
  if (d === 0) return { x, y };
  if (d === 90) return { x: height - 1 - y, y: x };
  if (d === 180) return { x: width - 1 - x, y: height - 1 - y };
  return { x: y, y: width - 1 - x }; // 270
}

/**
 * 局部标尺：在相邻 ladder 点之间对 log10(bp) 做分段线性插值。
 * 输入按 s 升序。返回插值函数与单调性判定。
 */
export interface LadderCalibPoint {
  ladderBandId: string;
  s: number;
  bp: number;
}

export interface LocalCalibration {
  monotonic: boolean;
  /** 按 s 升序的点（仅保留检测到的，且 bp>0）。 */
  points: LadderCalibPoint[];
  /** 在 s 处插值 bp；s 超出有效区间返回 null。 */
  interpolate(s: number): { bp: number; segmentId: string; inside: boolean } | null;
  validLo: number;
  validHi: number;
  /** 全局 log10 线性拟合残差（供残差叠加层）。 */
  residuals: Record<string, number>;
  fitLogBp(s: number): number;
}

export function buildLocalCalibration(raw: LadderCalibPoint[]): {
  calib: LocalCalibration | null;
  monotonic: boolean;
  reason: string;
} {
  const pts = [...raw]
    .filter((p) => Number.isFinite(p.s) && Number.isFinite(p.bp) && p.bp > 0)
    .sort((a, b) => a.s - b.s);
  if (pts.length < 2) {
    return { calib: null, monotonic: true, reason: 'ladder-points-insufficient' };
  }
  // 非单调：迁移距离增大（越跑越远）时分子量必须单调递减。
  let monotonic = true;
  for (let i = 1; i < pts.length; i++) {
    if (!(pts[i]!.bp < pts[i - 1]!.bp)) {
      monotonic = false;
      break;
    }
  }
  const logBp = pts.map((p) => Math.log10(p.bp));
  // 最小二乘 log10(bp) = a*s + b
  const n = pts.length;
  const meanS = pts.reduce((a, p) => a + p.s, 0) / n;
  const meanL = logBp.reduce((a, v) => a + v, 0) / n;
  let num = 0;
  let den = 0;
  pts.forEach((p, i) => {
    num += (p.s - meanS) * (logBp[i]! - meanL);
    den += (p.s - meanS) ** 2;
  });
  const a = den === 0 ? 0 : num / den;
  const b = meanL - a * meanS;
  const residuals: Record<string, number> = {};
  pts.forEach((p, i) => {
    residuals[p.ladderBandId] = logBp[i]! - (a * p.s + b);
  });

  if (!monotonic) {
    return {
      calib: {
        monotonic: false,
        points: pts,
        interpolate: () => null,
        validLo: NaN,
        validHi: NaN,
        residuals,
        fitLogBp: (s) => a * s + b,
      },
      monotonic: false,
      reason: 'non-monotonic-ladder',
    };
  }

  const interpolate = (s: number) => {
    if (s < pts[0]!.s - 1e-6 || s > pts[n - 1]!.s + 1e-6) {
      // 外推：标记 extrapolated 且给出区间，但默认不唯一
      return null;
    }
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i]!;
      const p1 = pts[i + 1]!;
      if (s <= p1.s + 1e-6) {
        const t = (s - p0.s) / Math.max(1e-9, p1.s - p0.s);
        const l0 = Math.log10(p0.bp);
        const l1 = Math.log10(p1.bp);
        const bp = 10 ** (l0 + t * (l1 - l0));
        return {
          bp,
          segmentId: `seg_${p0.ladderBandId}_${p1.ladderBandId}`,
          inside: s >= p0.s && s <= p1.s,
        };
      }
    }
    return null;
  };

  return {
    calib: {
      monotonic: true,
      points: pts,
      interpolate,
      validLo: pts[0]!.s,
      validHi: pts[n - 1]!.s,
      residuals,
      fitLogBp: (s) => a * s + b,
    },
    monotonic: true,
    reason: 'ok',
  };
}
