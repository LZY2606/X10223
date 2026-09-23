import type { PxPoint, PxPolyline } from '../types.ts';

export interface SampledCurve {
  pts: PxPoint[]; // 按弧长等步长
  cum: number[]; // 每点累计弧长 px
  total: number;
}

export function dist(a: PxPoint, b: PxPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function sampleCurve(polyline: PxPolyline, step = 1.5): SampledCurve {
  const pts: PxPoint[] = [];
  const cum: number[] = [];
  let total = 0;
  const src = polyline.points;
  for (let i = 0; i < src.length - 1; i++) {
    const a = src[i];
    const b = src[i + 1];
    const segLen = dist(a, b);
    const n = Math.max(1, Math.round(segLen / step));
    for (let k = 0; k < n; k++) {
      const f = k / n;
      pts.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f });
      cum.push(total + segLen * f);
    }
    total += segLen;
  }
  const last = src[src.length - 1];
  pts.push({ ...last });
  cum.push(total);
  return { pts, cum, total };
}

/** 点到曲线最近投影：返回沿曲线弧长 t 与最近点 */
export function projectToCurve(p: PxPoint, curve: SampledCurve): { t: number; nearest: PxPoint; d: number } {
  let best = Infinity;
  let idx = 0;
  for (let i = 0; i < curve.pts.length; i++) {
    const d = (curve.pts[i].x - p.x) ** 2 + (curve.pts[i].y - p.y) ** 2;
    if (d < best) {
      best = d;
      idx = i;
    }
  }
  return { t: curve.cum[idx], nearest: curve.pts[idx], d: Math.sqrt(best) };
}

function normalAt(curve: SampledCurve, idx: number): PxPoint {
  const a = curve.pts[Math.max(0, idx - 3)];
  const b = curve.pts[Math.min(curve.pts.length - 1, idx + 3)];
  const tx = b.x - a.x;
  const ty = b.y - a.y;
  const l = Math.hypot(tx, ty) || 1;
  return { x: -ty / l, y: tx / l };
}

/** 沿泳道中心线取暗度剖面：255-像素，按泳道半宽在法线方向平均 */
export function laneProfile(
  pixels: Uint8Array,
  width: number,
  height: number,
  centerline: PxPolyline,
  halfWidth: number
): { t: number[]; v: number[] } {
  const curve = sampleCurve(centerline, 1.5);
  const t: number[] = [];
  const v: number[] = [];
  for (let i = 0; i < curve.pts.length; i += 2) {
    const p = curve.pts[i];
    const n = normalAt(curve, i);
    let sum = 0;
    let count = 0;
    for (let off = -halfWidth; off <= halfWidth; off += 2) {
      const x = Math.round(p.x + n.x * off);
      const y = Math.round(p.y + n.y * off);
      if (x >= 0 && y >= 0 && x < width && y < height) {
        sum += 255 - pixels[y * width + x];
        count++;
      }
    }
    t.push(curve.cum[i]);
    v.push(count ? sum / count : 0);
  }
  return { t, v };
}

export function pointInBounds(p: PxPoint, width: number, height: number, margin = 0): boolean {
  return p.x >= -margin && p.y >= -margin && p.x < width + margin && p.y < height + margin;
}

export function rotatePointCW90(p: PxPoint, oldWidth: number): PxPoint {
  return { x: p.y, y: oldWidth - 1 - p.x };
}
