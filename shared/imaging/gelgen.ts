import type { PixelPoint } from "../types.ts";
import type { RasterImage } from "./png.ts";

export interface SyntheticBand {
  /** 沿 lane 的迁移比例 0..1（自上而下）。 */
  t: number;
  /** 相对亮度 0..2（>1 必然饱和）。 */
  intensity: number;
  /** 条带半高（px 方向，沿 lane）。 */
  sigmaS: number;
  /** 横向半宽比例（相对 lane 半宽）。 */
  sigmaW: number;
  /** 拖尾：向下延展的指数长度（px），0 表示无。 */
  tail?: number;
}

export interface SyntheticLane {
  isLadder: boolean;
  /** 弯曲类型：直线 / 微笑（中间向下凹）。 */
  bend?: "straight" | "smile";
  bendAmpPx?: number;
  bands: SyntheticBand[];
}

export interface GelSpec {
  width: number;
  height: number;
  lanes: SyntheticLane[];
  laneHalfWidth: number;
  bgNoise?: number;
  seed: number;
}

export interface GelGroundTruth {
  image: RasterImage;
  laneCenters: { laneIndex: number; points: PixelPoint[]; isLadder: boolean }[];
  bandTruth: { laneIndex: number; t: number; center: PixelPoint; saturated: boolean; overlapWith?: number }[];
}

/** mulberry32 确定性随机数。 */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateGel(spec: GelSpec): GelGroundTruth {
  const { width, height } = spec;
  const data = new Uint8Array(width * height * 4);
  const random = rng(spec.seed);
  const n = spec.lanes.length;
  const marginX = Math.round(width * 0.08);
  const top = Math.round(height * 0.08);
  const bottom = Math.round(height * 0.92);
  const centers: number[] = [];
  for (let i = 0; i < n; i++) centers.push(marginX + ((width - 2 * marginX) * (i + 0.5)) / n);

  const lanePolys: ((t: number) => PixelPoint)[] = spec.lanes.map((lane, i) => {
    const cx = centers[i]!;
    if (lane.bend === "smile") {
      const amp = lane.bendAmpPx ?? Math.round(height * 0.06);
      // 微笑：边缘 lane 几乎直，中间最弯；中点向下偏移
      const edgeFactor = 1 - Math.abs((i / Math.max(1, n - 1)) * 2 - 1);
      const a = amp * edgeFactor;
      return (t: number) => ({ x: cx, y: top + (bottom - top) * t + a * 4 * t * (1 - t) });
    }
    return (t: number) => ({ x: cx, y: top + (bottom - top) * t });
  });

  const bandTruth: GelGroundTruth["bandTruth"] = [];

  // 背景：轻微纵向渐变 + 噪声（凝胶暗、条带亮）
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const grad = 26 + 10 * (y / height);
      const noise = (random() - 0.5) * (spec.bgNoise ?? 10);
      const v = clamp(grad + noise);
      const idx = (y * width + x) * 4;
      data[idx] = data[idx + 1] = data[idx + 2] = v;
      data[idx + 3] = 255;
    }
  }

  // 加条带（加性发光，遇 255 饱和，形成真正的饱和平台）
  const addBand = (li: number, b: SyntheticBand, partnerT?: number) => {
    const poly = lanePolys[li]!;
    const c = poly(b.t);
    let saturated = false;
    const reach = 3 * Math.max(b.sigmaS, spec.laneHalfWidth * (b.sigmaW ?? 0.8));
    for (let t = b.t - reach / (bottom - top); t <= b.t + reach / (bottom - top) + (b.tail ?? 0) / (bottom - top); t += 1 / (bottom - top)) {
      if (t < 0 || t > 1.05) continue;
      const p = poly(Math.min(1, t));
      for (let dx = -spec.laneHalfWidth; dx <= spec.laneHalfWidth; dx++) {
        const x = Math.round(p.x + dx);
        const y = Math.round(p.y);
        if (x < 0 || x >= width || y < 0 || y >= height) continue;
        const dt = t - b.t;
        let g = Math.exp(-(dt * (bottom - top)) ** 2 / (2 * b.sigmaS ** 2));
        g *= Math.exp(-(dx ** 2) / (2 * (spec.laneHalfWidth * (b.sigmaW ?? 0.8)) ** 2));
        if (b.tail && dt > 0) g += b.intensity * 0.25 * Math.exp(-(dt * (bottom - top)) / b.tail) * Math.exp(-(dx ** 2) / (2 * (spec.laneHalfWidth * 0.9) ** 2));
        const add = 210 * b.intensity * g;
        const idx = (y * width + x) * 4;
        const nv = data[idx]! + add;
        if (nv >= 255) saturated = true;
        const cv = clamp(nv);
        data[idx] = data[idx + 1] = data[idx + 2] = cv;
      }
    }
    bandTruth.push({
      laneIndex: li,
      t: b.t,
      center: { x: Math.round(c.x), y: Math.round(c.y) },
      saturated,
      overlapWith: partnerT === undefined ? undefined : li,
    });
  };

  spec.lanes.forEach((lane, li) => {
    lane.bands.forEach((b) => {
      const partner = lane.bands.find((other) => other !== b && Math.abs(other.t - b.t) * (bottom - top) < 2.5 * Math.max(b.sigmaS, other.sigmaS));
      addBand(li, b, partner ? partner.t : undefined);
    });
  });

  const laneCenters = lanePolys.map((poly, laneIndex) => {
    const points: PixelPoint[] = [];
    for (let k = 0; k <= 8; k++) points.push(poly(k / 8));
    return { laneIndex, points, isLadder: spec.lanes[laneIndex]!.isLadder };
  });

  return { image: { width, height, data }, laneCenters, bandTruth };
}

function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** 90° 顺时针旋转（生成旋转材料时用；业务层旋转走新 CoordinateFrame）。 */
export function rotate90cw(img: RasterImage): RasterImage {
  const out = new Uint8Array(img.height * img.width * 4);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const nx = img.height - 1 - y;
      const ny = x;
      const si = (y * img.width + x) * 4;
      const di = (ny * img.height + nx) * 4;
      out[di] = img.data[si]!;
      out[di + 1] = img.data[si + 1]!;
      out[di + 2] = img.data[si + 2]!;
      out[di + 3] = img.data[si + 3]!;
    }
  }
  return { width: img.height, height: img.width, data: out };
}
