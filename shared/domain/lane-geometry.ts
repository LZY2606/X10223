import type { PixelPoint } from "../types.ts";

/** 向心 Catmull-Rom（alpha=0.5）插值，t∈[0,1] 在 p1..p2 段内。 */
function catmullRom(p0: PixelPoint, p1: PixelPoint, p2: PixelPoint, p3: PixelPoint, t: number): PixelPoint {
  const alpha = 0.5;
  const tj = (ti: number, a: PixelPoint, b: PixelPoint) => {
    const d = (a.x - b.x) ** 2 + (a.y - b.y) ** 2;
    return ti + Math.pow(d, 0.5 * alpha);
  };
  const t0 = 0;
  const t1 = tj(t0, p0, p1);
  const t2 = tj(t1, p1, p2);
  const t3 = tj(t2, p2, p3);
  const tval = t1 + (t2 - t1) * t;
  const a1x = ((t1 - tval) / (t1 - t0 || 1)) * p0.x + ((tval - t0) / (t1 - t0 || 1)) * p1.x;
  const a1y = ((t1 - tval) / (t1 - t0 || 1)) * p0.y + ((tval - t0) / (t1 - t0 || 1)) * p1.y;
  const a2x = ((t2 - tval) / (t2 - t1 || 1)) * p1.x + ((tval - t1) / (t2 - t1 || 1)) * p2.x;
  const a2y = ((t2 - tval) / (t2 - t1 || 1)) * p1.y + ((tval - t1) / (t2 - t1 || 1)) * p2.y;
  const a3x = ((t3 - tval) / (t3 - t2 || 1)) * p2.x + ((tval - t2) / (t3 - t2 || 1)) * p3.x;
  const a3y = ((t3 - tval) / (t3 - t2 || 1)) * p2.y + ((tval - t2) / (t3 - t2 || 1)) * p3.y;
  const b1x = ((t2 - tval) / (t2 - t0 || 1)) * a1x + ((tval - t0) / (t2 - t0 || 1)) * a2x;
  const b1y = ((t2 - tval) / (t2 - t0 || 1)) * a1y + ((tval - t0) / (t2 - t0 || 1)) * a2y;
  const b2x = ((t3 - tval) / (t3 - t1 || 1)) * a2x + ((tval - t1) / (t3 - t1 || 1)) * a3x;
  const b2y = ((t3 - tval) / (t3 - t1 || 1)) * a2y + ((tval - t1) / (t3 - t1 || 1)) * a3y;
  const cx = ((t2 - tval) / (t2 - t1 || 1)) * b1x + ((tval - t1) / (t2 - t1 || 1)) * b2x;
  const cy = ((t2 - tval) / (t2 - t1 || 1)) * b1y + ((tval - t1) / (t2 - t1 || 1)) * b2y;
  return { x: cx, y: cy };
}

export interface SampledCurve {
  /** 均匀采样点。 */
  pts: PixelPoint[];
  /** 累积弧长（px），cumS[i] 对应 pts[i]，cumS[0]=0。 */
  cumS: number[];
  totalLength: number;
}

const STEPS_PER_SEGMENT = 24;

/** 由控制点生成弧长参数化的采样曲线。 */
export function sampleCurve(control: PixelPoint[]): SampledCurve {
  if (control.length < 2) {
    return { pts: control.slice(), cumS: control.map(() => 0), totalLength: 0 };
  }
  const ext: PixelPoint[] = [extrap(control[1]!, control[0]!), ...control, extrap(control[control.length - 2]!, control[control.length - 1]!)];
  const pts: PixelPoint[] = [];
  for (let seg = 1; seg < ext.length - 2; seg++) {
    const maxT = seg === ext.length - 3 ? 1 : 1;
    const start = seg === 1 ? 0 : 1;
    for (let step = start * STEPS_PER_SEGMENT; step <= maxT * STEPS_PER_SEGMENT; step++) {
      if (seg > 1 && step === 0) continue;
      pts.push(catmullRom(ext[seg - 1]!, ext[seg]!, ext[seg + 1]!, ext[seg + 2]!, step / STEPS_PER_SEGMENT));
    }
  }
  const cumS = [0];
  for (let i = 1; i < pts.length; i++) {
    const d = Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
    cumS.push(cumS[i - 1]! + d);
  }
  return { pts, cumS, totalLength: cumS[cumS.length - 1] ?? 0 };
}

function extrap(a: PixelPoint, b: PixelPoint): PixelPoint {
  return { x: b.x + (b.x - a.x), y: b.y + (b.y - a.y) };
}

/** 由弧长 s 反查曲线点（线性反查采样）。 */
export function pointAtS(curve: SampledCurve, s: number): { point: PixelPoint; index: number } {
  const { cumS, pts } = curve;
  if (s <= 0) return { point: pts[0]!, index: 0 };
  for (let i = 1; i < cumS.length; i++) {
    if (cumS[i]! >= s) {
      const s0 = cumS[i - 1]!;
      const s1 = cumS[i]!;
      const t = s1 === s0 ? 0 : (s - s0) / (s1 - s0);
      return {
        point: {
          x: pts[i - 1]!.x + (pts[i]!.x - pts[i - 1]!.x) * t,
          y: pts[i - 1]!.y + (pts[i]!.y - pts[i - 1]!.y) * t,
        },
        index: i,
      };
    }
  }
  return { point: pts[pts.length - 1]!, index: pts.length - 1 };
}

/** 像素点投影到曲线，返回最近 s（用于人工点击 / 弯曲泳道重投影）。 */
export function projectToCurve(curve: SampledCurve, p: PixelPoint): { s: number; point: PixelPoint; distance: number } {
  let best = { s: 0, dist: Infinity, point: curve.pts[0]! };
  for (let i = 0; i < curve.pts.length; i++) {
    const d = Math.hypot(curve.pts[i]!.x - p.x, curve.pts[i]!.y - p.y);
    if (d < best.dist) best = { s: curve.cumS[i]!, dist: d, point: curve.pts[i]! };
  }
  return { s: best.s, distance: best.dist, point: best.point };
}

/** 沿曲线取法向（单位向量），用于画 lane 边界与带状区域。 */
export function normalAtS(curve: SampledCurve, s: number): PixelPoint {
  const { index } = pointAtS(curve, s);
  const a = curve.pts[Math.max(0, index - 1)]!;
  const b = curve.pts[Math.min(curve.pts.length - 1, index + 1)]!;
  const tx = b.x - a.x;
  const ty = b.y - a.y;
  const len = Math.hypot(tx, ty) || 1;
  return { x: -ty / len, y: tx / len };
}
