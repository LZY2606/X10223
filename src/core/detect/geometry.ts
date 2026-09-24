import type { LaneBoundary, LaneCurvePoint } from '../types';

export interface Pt { x: number; y: number }

// 从闭合 lane polygon 提取左右边界（按 y 重采样为 x(y)）。
// polygon 约定：左缘自顶到底，接右缘自底回到顶。
export function edgesFromPolygon(poly: Pt[]): { left: Pt[]; right: Pt[] } {
  if (poly.length < 3) throw new Error('lane polygon 至少需要 3 个点');
  let topI = 0;
  for (let i = 1; i < poly.length; i++) {
    if (poly[i].y < poly[topI].y || (poly[i].y === poly[topI].y && poly[i].x < poly[topI].x)) topI = i;
  }
  const n = poly.length;
  let botI = topI;
  for (let k = 1; k < n; k++) {
    const i = (topI + k) % n;
    if (poly[i].y > poly[botI].y) botI = i;
  }
  const chainForward: Pt[] = [];
  for (let k = 0; ; k++) {
    chainForward.push(poly[(topI + k) % n]);
    if ((topI + k) % n === botI) break;
  }
  const chainBackward: Pt[] = [];
  for (let k = 0; ; k++) {
    chainBackward.push(poly[(topI - k + n * 4) % n]);
    if ((topI - k + n * 4) % n === botI) break;
  }
  // 用 x 中位数区分左右
  const mf = median(chainForward.map(p => p.x));
  const mb = median(chainBackward.map(p => p.x));
  return mf <= mb ? { left: chainForward, right: chainBackward } : { left: chainBackward, right: chainForward };
}

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function interpX(chain: Pt[], y: number): number {
  if (y <= chain[0].y) return chain[0].x;
  if (y >= chain[chain.length - 1].y) return chain[chain.length - 1].x;
  for (let i = 0; i < chain.length - 1; i++) {
    const a = chain[i], b = chain[i + 1];
    if (y >= a.y && y <= b.y) {
      const t = (y - a.y) / Math.max(1e-9, b.y - a.y);
      return a.x + (b.x - a.x) * t;
    }
  }
  return chain[chain.length - 1].x;
}

// 中心线 + 弧长坐标。返回逐像素 y 的曲线点。
export function centerline(boundary: LaneBoundary): LaneCurvePoint[] {
  const { left, right } = edgesFromPolygon(boundary.polygon);
  const y0 = Math.ceil(Math.max(left[0].y, right[0].y));
  const y1 = Math.floor(Math.min(left[left.length - 1].y, right[right.length - 1].y));
  const pts: LaneCurvePoint[] = [];
  let s = 0;
  let prev: Pt | null = null;
  for (let y = y0; y <= y1; y++) {
    const xl = interpX(left, y);
    const xr = interpX(right, y);
    const p = { x: (xl + xr) / 2, y };
    if (prev) s += Math.hypot(p.x - prev.x, p.y - prev.y);
    prev = p;
    pts.push({ x: p.x, y, s, width: Math.abs(xr - xl) });
  }
  return pts;
}

export function curvatureOffset(curve: LaneCurvePoint[]): number {
  if (curve.length < 3) return 0;
  const a = curve[0], b = curve[curve.length - 1];
  let maxD = 0;
  for (const p of curve) {
    const t = (p.y - a.y) / Math.max(1e-9, b.y - a.y);
    const chordX = a.x + (b.x - a.x) * t;
    maxD = Math.max(maxD, Math.abs(p.x - chordX));
  }
  return maxD;
}
