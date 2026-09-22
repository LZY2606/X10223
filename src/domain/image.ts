import type { Pt } from './geometry.js';
import { pointAtArcLength, polylineLength, projectToPolyline, tangentAt, rotatePoint } from './geometry.js';

export interface Raster16 {
  width: number;
  height: number;
  data: Uint16Array;
  maxSensorValue: number;
}

export interface RenderedBand {
  /** 沿车道中心折线弧长 */
  s: number;
  /** 0..1 峰值强度 */
  intensity: number;
  /** 沿迁移方向高斯 sigma（px） */
  sigmaS: number;
  /** 横向 sigma（px） */
  sigmaX: number;
  /** 拖尾：向下（更大 s）指数衰减长度；0=无拖尾 */
  smear: number;
  /** 人工制造饱和（削顶） */
  saturate: boolean;
}

export interface RenderedLane {
  centerline: Pt[];
  halfWidth: number;
  bands: RenderedBand[];
}

export interface RenderScene {
  width: number;
  height: number;
  lanes: RenderedLane[];
  background: number;
  noise: number;
  seed: number;
  maxSensorValue: number;
}

/** 确定性 PRNG，保证等价输入得到等价图像。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 从解析场景渲染 16 位灰度凝胶原始图。 */
export function renderGel(scene: RenderScene): Raster16 {
  const { width, height, maxSensorValue } = scene;
  const data = new Uint16Array(width * height);
  const rand = mulberry32(scene.seed);
  const lanes = scene.lanes.map((l) => ({ l, len: polylineLength(l.centerline) }));

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = scene.background;
      for (const { l } of lanes) {
        const pr = projectToPolyline(l.centerline, { x, y });
        if (Math.abs(pr.lateral) > l.halfWidth + 6) continue;
        const lat = pr.lateral;
        for (const b of l.bands) {
          let ds = pr.s - b.s;
          // 向上折回（带只向下拖尾）
          let along = Math.exp(-(ds * ds) / (2 * b.sigmaS * b.sigmaS));
          if (b.smear > 0 && ds > 0) {
            along = Math.max(along, Math.exp(-ds / b.smear) * 0.9);
          }
          const across = Math.exp(-(lat * lat) / (2 * b.sigmaX * b.sigmaX));
          v += b.intensity * along * across;
        }
      }
      v += (rand() - 0.5) * scene.noise;
      if (v > 1) v = 1;
      if (v < 0) v = 0;
      data[y * width + x] = Math.round(v * maxSensorValue);
    }
  }
  return { width, height, data, maxSensorValue };
}

/** 顺时针旋转角 angleDeg 的重采样（双线性），返回新画布。 */
export function rotateRaster(src: Raster16, angleDeg: number): Raster16 {
  if (((angleDeg % 360) + 360) % 360 === 0) return src;
  const rad = (angleDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const w = src.width;
  const h = src.height;
  const outW = Math.ceil(Math.abs(w * cos) + Math.abs(h * sin));
  const outH = Math.ceil(Math.abs(w * sin) + Math.abs(h * cos));
  const out = new Uint16Array(outW * outH);
  const cxs = (w - 1) / 2;
  const cys = (h - 1) / 2;
  const cxd = (outW - 1) / 2;
  const cyd = (outH - 1) / 2;
  const sample = (x: number, y: number): number => {
    x -= cxd;
    y -= cyd;
    const sx = cos * x + sin * y + cxs;
    const sy = -sin * x + cos * y + cys;
    const x0 = Math.floor(sx);
    const y0 = Math.floor(sy);
    if (x0 < 0 || y0 < 0 || x0 >= w - 1 || y0 >= h - 1) return 0;
    const tx = sx - x0;
    const ty = sy - y0;
    const a = src.data[y0 * w + x0]!;
    const b = src.data[y0 * w + x0 + 1]!;
    const c = src.data[(y0 + 1) * w + x0]!;
    const d = src.data[(y0 + 1) * w + x0 + 1]!;
    return a * (1 - tx) * (1 - ty) + b * tx * (1 - ty) + c * (1 - tx) * ty + d * tx * ty;
  };
  for (let y = 0; y < outH; y++) {
    for (let x = 0; x < outW; x++) {
      out[y * outW + x] = Math.round(sample(x, y));
    }
  }
  return { width: outW, height: outH, data: out, maxSensorValue: src.maxSensorValue };
}

/** 校正图像坐标 -> 原始图像坐标（带旋转；翻转暂不支持自动案例）。 */
export function correctedToRawPoint(p: Pt, angleDeg: number, rawW: number, rawH: number): Pt {
  // rotatePoint 是 raw->corrected，反向用负角并以 raw 中心
  return rotatePoint(p, angleDeg, rawW, rawH);
}

export interface BandProfile {
  s: number;
  intensity: number;
  /** 半高宽（沿弧长，px） */
  fwhm: number;
  flatTop: boolean;
  saturated: boolean;
  smeared: boolean;
  /** 向下拖尾比 */
  tailRatio: number;
  center: Pt;
}

export interface LaneProfile {
  samples: { s: number; v: number }[];
  peaks: BandProfile[];
}

/** 沿车道取剖面：在每弧长位置横向平均 halfWidth*2 条法线采样。 */
export function sampleLaneProfile(raster: Raster16, centerline: Pt[], halfWidth: number, step = 1): LaneProfile {
  const len = polylineLength(centerline);
  const samples: { s: number; v: number }[] = [];
  for (let s = 0; s <= len; s += step) {
    const c = pointAtArcLength(centerline, s);
    const ang = tangentAt(centerline, s);
    const nx = -Math.sin(ang);
    const ny = Math.cos(ang);
    let sum = 0;
    let n = 0;
    for (let off = -halfWidth + 1; off <= halfWidth - 1; off += 2) {
      const px = Math.round(c.x + nx * off);
      const py = Math.round(c.y + ny * off);
      if (px >= 0 && py >= 0 && px < raster.width && py < raster.height) {
        sum += raster.data[py * raster.width + px]!;
        n++;
      }
    }
    samples.push({ s, v: n ? sum / n / raster.maxSensorValue : 0 });
  }
  return { samples, peaks: [] };
}

export interface DetectOptions {
  /** 峰值阈值（剖面归一化） */
  peakThreshold: number;
  /** 饱和比例 */
  saturationThreshold: number;
  /** 拖尾判定：下半宽/上半宽 */
  smearRatio: number;
  minPeakSeparation: number;
  /** 重叠判定：谷值高于两峰较低者的该比例 */
  overlapValleyRatio: number;
}

/** 在剖面中检测峰并标注饱和、削顶、拖尾、重叠。 */
export function detectPeaks(profile: LaneProfile, opt: DetectOptions): BandProfile[] {
  const { samples } = profile;
  const peaks: BandProfile[] = [];
  for (let i = 2; i < samples.length - 2; i++) {
    const v = samples[i]!.v;
    if (v < opt.peakThreshold) continue;
    if (v > samples[i - 1]!.v && v >= samples[i + 1]!.v && v > samples[i - 2]!.v && v >= samples[i + 2]!.v) {
      peaks.push(describePeak(samples, i, opt));
    }
  }
  // 平台型（饱和削顶）：连续 plateau，取其中点作为一个峰
  const plateaus = findPlateaus(samples, opt.saturationThreshold);
  for (const pl of plateaus) {
    if (!peaks.some((p) => Math.abs(p.s - pl.s) <= opt.minPeakSeparation)) peaks.push(pl);
  }
  peaks.sort((a, b) => a.s - b.s);
  // 过近峰：拒绝过密后再判重叠
  const merged: BandProfile[] = [];
  for (const p of peaks) {
    const prev = merged[merged.length - 1];
    if (prev && p.s - prev.s < opt.minPeakSeparation) continue;
    merged.push(p);
  }
  for (let i = 0; i < merged.length; i++) {
    const p = merged[i]!;
    const neighbors: number[] = [];
    for (let j = 0; j < merged.length; j++) {
      if (j === i) continue;
      const q = merged[j]!;
      if (Math.abs(q.s - p.s) > (p.fwhm + q.fwhm) * 1.2) continue;
      const lo = Math.min(p.s, q.s);
      const hi = Math.max(p.s, q.s);
      let valley = 1;
      for (const sm of samples) {
        if (sm.s > lo && sm.s < hi) valley = Math.min(valley, sm.v);
      }
      if (valley > Math.min(p.intensity, q.intensity) * opt.overlapValleyRatio) neighbors.push(j);
    }
    (p as BandProfile & { neighborIndexes?: number[] }).neighborIndexes = neighbors;
  }
  return merged;
}

function describePeak(samples: { s: number; v: number }[], i: number, opt: DetectOptions): BandProfile {
  const peak = samples[i]!;
  const half = peak.v * 0.5;
  let lo = i;
  let hi = i;
  while (lo > 0 && samples[lo - 1]!.v > half) lo--;
  while (hi < samples.length - 1 && samples[hi + 1]!.v > half) hi++;
  const fwhm = samples[hi]!.s - samples[lo]!.s;
  // 拖尾：用 30% 高宽上下不对称
  const thr30 = peak.v * 0.3;
  let tLo = i;
  let tHi = i;
  while (tLo > 0 && samples[tLo - 1]!.v > thr30) tLo--;
  while (tHi < samples.length - 1 && samples[tHi + 1]!.v > thr30) tHi++;
  const up = peak.s - samples[tLo]!.s;
  const down = samples[tHi]!.s - peak.s;
  const tailRatio = down / Math.max(up, 1e-6);
  return {
    s: peak.s,
    intensity: peak.v,
    fwhm,
    flatTop: false,
    saturated: peak.v >= opt.saturationThreshold,
    smeared: tailRatio >= opt.smearRatio,
    tailRatio,
    center: { x: 0, y: peak.s },
  };
}

function findPlateaus(samples: { s: number; v: number }[], sat: number): BandProfile[] {
  const out: BandProfile[] = [];
  let i = 0;
  while (i < samples.length) {
    if (samples[i]!.v >= sat) {
      const start = i;
      while (i < samples.length && samples[i]!.v >= sat) i++;
      const end = i - 1;
      if (end - start >= 2) {
        const mid = (start + end) >> 1;
        out.push({
          s: samples[mid]!.s,
          intensity: samples[mid]!.v,
          fwhm: samples[end]!.s - samples[start]!.s,
          flatTop: true,
          saturated: true,
          smeared: false,
          tailRatio: 1,
          center: { x: 0, y: samples[mid]!.s },
        });
      }
    } else i++;
  }
  return out;
}

/** 把剖面峰转成图像坐标（弧长 -> 折线点）。 */
export function peakToImagePoint(centerline: Pt[], peak: BandProfile): Pt {
  return pointAtArcLength(centerline, peak.s);
}
