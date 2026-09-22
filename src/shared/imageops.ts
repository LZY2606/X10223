import { grayAt, type Raster } from './png.js';
import { centerline, cumulativeLength, pointAtArc } from './geometry.js';
import type { Point } from '../shared/types.js';
import type { LaneBoundaryMaterial } from './types.js';

export function rotate90Cw(raster: Raster): { raster: Raster; map: (p: Point) => Point } {
  // (x,y) -> (H-1-y, x)
  const width = raster.height;
  const height = raster.width;
  const data = new Uint8Array(width * height * raster.channels);
  for (let y = 0; y < raster.height; y++) {
    for (let x = 0; x < raster.width; x++) {
      const nx = raster.height - 1 - y;
      const ny = x;
      for (let c = 0; c < raster.channels; c++) {
        data[(ny * width + nx) * raster.channels + c] =
          raster.data[(y * raster.width + x) * raster.channels + c];
      }
    }
  }
  const H = raster.height;
  return {
    raster: { width, height, channels: raster.channels, data },
    map: (p: Point) => ({ x: H - 1 - p.y, y: p.x }),
  };
}

/** “微笑”弯曲：在像素层重采样，使泳道中心横向偏移呈抛物线。 */
export function warpSmile(
  raster: Raster,
  ampPx: number,
): { raster: Raster; map: (p: Point) => Point; shiftAt: (y: number) => number } {
  const { width, height, channels, data } = raster;
  const out = new Uint8Array(data.length);
  const shiftAt = (y: number) => {
    const t = (y / Math.max(1, height - 1) - 0.5) * 2;
    return Math.round(ampPx * t * t);
  };
  for (let y = 0; y < height; y++) {
    const shift = shiftAt(y);
    for (let x = 0; x < width; x++) {
      const sx = x - shift;
      for (let c = 0; c < channels; c++) {
        if (sx < 0 || sx >= width) {
          out[(y * width + x) * channels + c] = 245;
        } else {
          out[(y * width + x) * channels + c] =
            raster.data[(y * width + sx) * channels + c];
        }
      }
    }
  }
  return {
    raster: { width, height, channels, data: out },
    map: (p: Point) => ({ x: p.x + shiftAt(p.y), y: p.y }),
    shiftAt,
  };
}

export interface ProfilePoint {
  s: number;
  intensity: number; // 0..255
  saturatedFraction: number;
}

/** 沿泳道中心线对横截面平均取灰度剖面（弧长重采样）。 */
export function laneProfile(
  raster: Raster,
  lane: LaneBoundaryMaterial,
  stepPx = 2,
): { center: Point[]; profile: ProfilePoint[]; arcLength: number; saturatedFractionTotal: number } {
  const center = centerline(lane.left, lane.right);
  const { total } = cumulativeLength(center);
  const profile: ProfilePoint[] = [];
  let satTotal = 0;
  let sampleCount = 0;
  for (let s = 0; s <= total; s += stepPx) {
    const { point, tangent } = pointAtArc(center, s);
    const normal = { x: -tangent.y, y: tangent.x };
    const halfWidth = 7;
    let sum = 0;
    let count = 0;
    let sat = 0;
    for (let w = -halfWidth; w <= halfWidth; w++) {
      const g = grayAt(
        raster,
        Math.round(point.x + normal.x * w),
        Math.round(point.y + normal.y * w),
      );
      sum += g;
      count++;
      if (g >= 250) sat++;
    }
    const mean = sum / Math.max(1, count);
    profile.push({ s, intensity: mean, saturatedFraction: sat / Math.max(1, count) });
    satTotal += sat;
    sampleCount += count;
  }
  return {
    center,
    profile,
    arcLength: total,
    saturatedFractionTotal: sampleCount ? satTotal / sampleCount : 0,
  };
}

export interface Peak {
  s: number;
  height: number;
  halfWidth: number;
  saturated: boolean;
  smeared: boolean;
  overlap: boolean;
  partner?: number; // 重叠伙伴的弧长
  maxIntensity: number;
}

/**
 * 剖面峰检测：输出像素证据（半高宽、饱和占比、峰谷），
 * 由规则层决定候选/区间，而不是在检测层唯一化。
 */
export function detectPeaks(
  profile: ProfilePoint[],
  opts: {
    minHeight: number;
    saturationFraction: number;
    smearHalfWidthPx: number;
    overlapValleyRatio: number;
  },
): Peak[] {
  const baseline = profile.length
    ? Math.min(...profile.map((p) => p.intensity))
    : 0;
  const threshold = baseline + opts.minHeight;
  const peaks: Peak[] = [];
  for (let i = 1; i < profile.length - 1; i++) {
    const prev = profile[i - 1];
    const cur = profile[i];
    const next = profile[i + 1];
    if (cur.intensity > prev.intensity && cur.intensity >= next.intensity && cur.intensity >= threshold) {
      let left = i;
      while (left > 0 && profile[left - 1].intensity > baseline + (cur.intensity - baseline) * 0.5) left--;
      let right = i;
      while (
        right < profile.length - 1 &&
        profile[right + 1].intensity > baseline + (cur.intensity - baseline) * 0.5
      ) {
        right++;
      }
      const halfWidth = (profile[right].s - profile[left].s) / 2;
      peaks.push({
        s: cur.s,
        height: cur.intensity - baseline,
        halfWidth,
        saturated: cur.saturatedFraction >= opts.saturationFraction,
        smeared: halfWidth >= opts.smearHalfWidthPx,
        overlap: false,
        maxIntensity: cur.intensity,
      });
    }
  }
  // 合并过近且峰谷浅的双峰 → 标记 overlap（保留两个峰中心作为候选）
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < peaks.length; j++) {
      const gap = Math.abs(peaks[j].s - peaks[i].s);
      const minHalf = Math.min(peaks[i].halfWidth, peaks[j].halfWidth);
      if (gap < minHalf * 3) {
        const lo = Math.round(Math.min(peaks[i].s, peaks[j].s) / 2);
        const hi = Math.round(Math.max(peaks[i].s, peaks[j].s) / 2);
        const between = profile.filter((p) => p.s >= lo && p.s <= hi);
        const valley = between.length ? Math.min(...between.map((p) => p.intensity)) : 0;
        const rim = Math.min(peaks[i].maxIntensity, peaks[j].maxIntensity);
        if (valley > baseline + (rim - baseline) * opts.overlapValleyRatio) {
          peaks[i].overlap = true;
          peaks[j].overlap = true;
          peaks[i].partner = peaks[j].s;
          peaks[j].partner = peaks[i].s;
        }
      }
    }
  }
  return peaks.sort((a, b) => a.s - b.s);
}
