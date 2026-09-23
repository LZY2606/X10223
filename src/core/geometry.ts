import type { LaneCurve, PointPx, OrientationMaterial } from './types.js';

/** 原图坐标 -> 显示帧坐标（考虑方向：旋转/翻转）。 */
export function toDisplay(
  p: PointPx,
  imgW: number,
  imgH: number,
  ori: OrientationMaterial
): PointPx {
  let { u, v } = p;
  if (ori.flipH) u = imgW - 1 - u;
  if (ori.flipV) v = imgH - 1 - v;
  const r = ori.rotationDeg;
  if (r === 0) return { u, v };
  if (r === 90) return { u: imgH - 1 - v, v: u };
  if (r === 180) return { u: imgW - 1 - u, v: imgH - 1 - v };
  return { u: v, v: imgW - 1 - u }; // 270
}

/** 显示帧坐标 -> 原图坐标。 */
export function toOriginal(
  p: PointPx,
  imgW: number,
  imgH: number,
  ori: OrientationMaterial
): PointPx {
  let { u, v } = p;
  const r = ori.rotationDeg;
  let ou = 0;
  let ov = 0;
  if (r === 0) {
    ou = u;
    ov = v;
  } else if (r === 90) {
    ou = v;
    ov = imgH - 1 - u;
  } else if (r === 180) {
    ou = imgW - 1 - u;
    ov = imgH - 1 - v;
  } else {
    ou = imgW - 1 - v;
    ov = u;
  }
  if (ori.flipH) ou = imgW - 1 - ou;
  if (ori.flipV) ov = imgH - 1 - ov;
  return { u: ou, v: ov };
}

export function displaySize(imgW: number, imgH: number, ori: OrientationMaterial): { w: number; h: number } {
  return ori.rotationDeg === 90 || ori.rotationDeg === 270 ? { w: imgH, h: imgW } : { w: imgW, h: imgH };
}

/** 对 lane 中心线按 v 做线性插值，得到任意迁移位置 v 上的中心 u。 */
export function centerUAt(lane: LaneCurve, v: number): number {
  const pts = lane.center;
  if (pts.length === 0) throw new Error(`lane ${lane.laneId}: empty centerline`);
  const sorted = [...pts].sort((a, b) => a.v - b.v);
  if (v <= sorted[0].v) return sorted[0].u;
  const last = sorted[sorted.length - 1];
  if (v >= last.v) return last.u;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    if (v >= a.v && v <= b.v) {
      const t = (v - a.v) / (b.v - a.v || 1);
      return a.u + (b.u - a.u) * t;
    }
  }
  return last.u;
}

/** 弯曲量：中心线最大横向偏移与端到端直线的差（像素）。用于“微笑”判定。 */
export function curvaturePx(lane: LaneCurve): number {
  const pts = [...lane.center].sort((a, b) => a.v - b.v);
  if (pts.length < 2) return 0;
  const a = pts[0];
  const b = pts[pts.length - 1];
  let maxDev = 0;
  for (const p of pts) {
    const t = (p.v - a.v) / (b.v - a.v || 1);
    const lineU = a.u + (b.u - a.u) * t;
    maxDev = Math.max(maxDev, Math.abs(p.u - lineU));
  }
  return maxDev;
}

/** 沿弯曲泳道中心线积分的剖面（对横向半宽内像素取均值/最大值）。 */
export interface LaneProfile {
  laneId: string;
  v: number[];
  intensity: number[]; // 0..1
  saturation: number[]; // 每行饱和像素计数
  maxIntensity: number;
}

export function extractProfile(
  raster: Float32Array,
  satMask: Uint8Array | null,
  imgW: number,
  imgH: number,
  lane: LaneCurve
): LaneProfile {
  const v: number[] = [];
  const intensity: number[] = [];
  const saturation: number[] = [];
  let maxIntensity = 0;
  const hw = Math.max(1, Math.round(lane.halfWidthPx));
  for (let y = 0; y < imgH; y++) {
    const cu = centerUAt(lane, y);
    let sum = 0;
    let n = 0;
    let sat = 0;
    const x0 = Math.max(0, Math.round(cu - hw));
    const x1 = Math.min(imgW - 1, Math.round(cu + hw));
    for (let x = x0; x <= x1; x++) {
      sum += raster[y * imgW + x];
      if (satMask && satMask[y * imgW + x]) sat++;
      n++;
    }
    const m = n ? sum / n : 0;
    v.push(y);
    intensity.push(m);
    saturation.push(sat);
    maxIntensity = Math.max(maxIntensity, m);
  }
  return { laneId: lane.laneId, v, intensity, saturation, maxIntensity };
}
