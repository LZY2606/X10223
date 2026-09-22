import type { Point } from './types.js';
import { buildPolyline, pointAtS, projectToPolyline, rotatePointCW } from './geometry.js';

/**
 * 纯栅格（无 IO，可被测试直接调用）。
 * 单通道灰度，0..255，背景亮（凝胶）、条带暗。
 */
export class GrayRaster {
  readonly data: Uint8Array;
  constructor(
    readonly width: number,
    readonly height: number,
    data?: Uint8Array,
  ) {
    this.data = data ?? new Uint8Array(width * height).fill(235);
    if (this.data.length !== width * height) {
      throw new Error(`raster size mismatch ${this.data.length} != ${width}*${height}`);
    }
  }

  inBounds(x: number, y: number): boolean {
    return x >= 0 && y >= 0 && x < this.width && y < this.height;
  }

  get(x: number, y: number): number {
    if (!this.inBounds(x, y)) return 235;
    return this.data[y * this.width + x]!;
  }

  set(x: number, y: number, v: number): void {
    if (!this.inBounds(x, y)) return;
    this.data[y * this.width + x] = Math.max(0, Math.min(255, Math.round(v)));
  }

  /** 在 (cx,cy) 画暗高斯条带；amp 为变暗幅度，saturationLevel<=时硬裁剪。 */
  gaussianBand(
    cx: number,
    cy: number,
    sigmaX: number,
    sigmaY: number,
    amp: number,
    hardClip = 0,
  ): void {
    const rx = Math.ceil(sigmaX * 3);
    const ry = Math.ceil(sigmaY * 3);
    for (let y = cy - ry; y <= cy + ry; y++) {
      for (let x = cx - rx; x <= cx + rx; x++) {
        const dx = (x - cx) / sigmaX;
        const dy = (y - cy) / sigmaY;
        let dark = amp * Math.exp(-0.5 * (dx * dx + dy * dy));
        let v = this.get(x, y) - dark;
        if (hardClip > 0 && v <= hardClip) v = hardClip; // 饱和：曝光过度削顶
        this.set(x, y, v);
      }
    }
  }

  clone(): GrayRaster {
    return new GrayRaster(this.width, this.height, new Uint8Array(this.data));
  }

  /** 顺时针旋转，返回新栅格（原图保持不变）。 */
  rotateCW(clockwiseDegrees: number): GrayRaster {
    const d = ((clockwiseDegrees % 360) + 360) % 360;
    if (d === 0) return this.clone();
    const swap = d === 90 || d === 270;
    const nw = swap ? this.height : this.width;
    const nh = swap ? this.width : this.height;
    const out = new GrayRaster(nw, nh);
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        const p = rotatePointCW(x, y, this.width, this.height, d);
        out.set(p.x, p.y, this.get(x, y));
      }
    }
    return out;
  }

  /** 沿中心线采样“暗度”轮廓（255-gray，越暗越大），宽度方向积分平均。 */
  sampleProfile(centerline: Point[], halfWidth: number, step = 1): ProfileSample[] {
    const poly = buildPolyline(centerline);
    const samples: ProfileSample[] = [];
    for (let s = 0; s <= poly.length; s += step) {
      const c = pointAtS(poly, s);
      let sum = 0;
      let count = 0;
      // 用相邻点估计切线法线
      const ahead = pointAtS(poly, Math.min(poly.length, s + 1));
      const behind = pointAtS(poly, Math.max(0, s - 1));
      let tx = ahead.x - behind.x;
      let ty = ahead.y - behind.y;
      const tl = Math.hypot(tx, ty) || 1;
      tx /= tl;
      ty /= tl;
      const nx = -ty;
      const ny = tx;
      for (let w = -halfWidth; w <= halfWidth; w++) {
        const sx = Math.round(c.x + nx * w);
        const sy = Math.round(c.y + ny * w);
        if (this.inBounds(sx, sy)) {
          sum += 255 - this.get(sx, sy);
          count++;
        }
      }
      samples.push({
        s,
        x: c.x,
        y: c.y,
        darkness: count ? sum / count : 0,
        minGray: count ? 255 - sum / count : 255,
      });
    }
    return samples;
  }
}

export interface ProfileSample {
  s: number;
  x: number;
  y: number;
  darkness: number;
  minGray: number;
}

export interface FoundPeak {
  s: number;
  x: number;
  y: number;
  maxDarkness: number;
  minGray: number;
  /** 左/右半高位置（拖尾不对称用）。 */
  leftHalfS: number;
  rightHalfS: number;
  asymmetry: number;
  saturated: boolean;
  clippingFraction: number;
}

/**
 * 在暗度轮廓上找峰。返回候选峰、饱和与拖尾证据。
 * 阈值基于轮廓相对背景，避免使用魔法默认值伪装。
 */
export function findPeaks(
  samples: ProfileSample[],
  opts: { minProminence: number; saturationGray: number; mergeDistance: number },
): FoundPeak[] {
  if (samples.length < 3) return [];
  const dark = samples.map((p) => p.darkness);
  const baseline = Math.min(...dark);
  const peaks: FoundPeak[] = [];
  let i = 1;
  while (i < samples.length - 1) {
    if (dark[i]! >= dark[i - 1]! && dark[i]! >= dark[i + 1]! && dark[i]! - baseline >= opts.minProminence) {
      // 扩展平台
      let lo = i;
      let hi = i;
      while (lo > 0 && dark[lo - 1]! >= baseline + (dark[i]! - baseline) * 0.5) lo--;
      while (hi < dark.length - 1 && dark[hi + 1]! >= baseline + (dark[i]! - baseline) * 0.5) hi++;
      const half = baseline + (dark[i]! - baseline) * 0.5;
      let leftHalfS = samples[lo]!.s;
      let rightHalfS = samples[hi]!.s;
      for (let k = i; k > 0; k--) {
        if (dark[k]! >= half && dark[k - 1]! < half) {
          leftHalfS = samples[k]!.s;
          break;
        }
      }
      for (let k = i; k < samples.length - 1; k++) {
        if (dark[k]! >= half && dark[k + 1]! < half) {
          rightHalfS = samples[k]!.s;
          break;
        }
      }
      const center = samples[i]!;
      // 峰附近裁剪像素比例（饱和）
      let clip = 0;
      let total = 0;
      for (let k = lo; k <= hi; k++) {
        total++;
        if (samples[k]!.minGray <= opts.saturationGray) clip++;
      }
      const leftW = Math.max(1e-6, center.s - leftHalfS);
      const rightW = Math.max(1e-6, rightHalfS - center.s);
      const asymmetry = rightW / leftW;
      peaks.push({
        s: center.s,
        x: center.x,
        y: center.y,
        maxDarkness: center.darkness,
        minGray: center.minGray,
        leftHalfS,
        rightHalfS,
        asymmetry,
        saturated: center.minGray <= opts.saturationGray,
        clippingFraction: clip / total,
      });
      i = hi + 1;
    } else {
      i++;
    }
  }
  return mergeClosePeaks(peaks, opts.mergeDistance);
}

/**
 * 距离小于 mergeDistance 的峰视为重叠：保留全部峰（合法候选），
 * 由调用方标记 overlapped。绝不擅自合并成一个值。
 */
function mergeClosePeaks(peaks: FoundPeak[], mergeDistance: number): FoundPeak[] {
  const sorted = [...peaks].sort((a, b) => a.s - b.s);
  for (let i = 0; i < sorted.length; i++) {
    for (let j = i + 1; j < sorted.length; j++) {
      if (Math.abs(sorted[j]!.s - sorted[i]!.s) <= mergeDistance) {
        (sorted[i] as FoundPeak & { _overlap?: boolean })._overlap = true;
        (sorted[j] as FoundPeak & { _overlap?: boolean })._overlap = true;
      }
    }
  }
  return sorted;
}

export function isOverlapFlagged(p: FoundPeak): boolean {
  return Boolean((p as FoundPeak & { _overlap?: boolean })._overlap);
}

/** 把条带中心像素投影到 lane，得到迁移距离。 */
export function migrationOf(
  centerline: Point[],
  x: number,
  y: number,
): { s: number; distance: number; within: boolean } {
  const poly = buildPolyline(centerline);
  const r = projectToPolyline(poly, x, y);
  return { s: r.s, distance: r.distance, within: r.within };
}
