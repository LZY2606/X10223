import type { GrayImage } from '../png.js';
import { curveMetric, pointAtM, projectToCurve, clamp } from '../geometry.js';
import type { ParamSet, PixelPoint } from '../types.js';

export interface RawBand {
  centerPx: PixelPoint;
  box: { x0: number; y0: number; x1: number; y1: number };
  m: number;
  intensity: number;
  halfWidthPx: number;
  saturated: boolean;
  smeared: boolean;
  plateauMRange?: { mLo: number; mHi: number };
  smearMRange?: { mLo: number; mHi: number };
  merged: boolean;
  mRange?: { mLo: number; mHi: number };
}

/** 沿泳道曲线采样亮度（横向取半宽内最大值），并以自适应基线扣除背景 */
export function laneProfile(img: GrayImage, center: PixelPoint[], halfWidth: number) {
  const { totalLength } = curveMetric(center);
  const n = Math.max(40, Math.round(totalLength));
  const m = new Float64Array(n);
  const intensity = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    m[i] = i / (n - 1);
    const p = pointAtM(center, m[i]);
    let best = -Infinity;
    for (let dx = -halfWidth; dx <= halfWidth; dx++) {
      const x = Math.round(p.x + dx);
      const y = Math.round(p.y);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const v = img.data[y * img.width + x];
      if (v > best) best = v;
    }
    intensity[i] = best;
  }
  const baseline = percentile(intensity, 0.1);
  for (let i = 0; i < n; i++) intensity[i] = Math.max(0, intensity[i] - baseline);
  return { m, intensity };
}

function percentile(a: Float64Array, q: number): number {
  const s = Float64Array.from(a).sort();
  return s[Math.floor((s.length - 1) * q)];
}

/** 峰检测 + 合并：谷底低于 overlapValleyRatio*min峰高 才允许分开，否则视为重叠（区间） */
export function detectBands(img: GrayImage, center: PixelPoint[], halfWidth: number, params: ParamSet['values']): RawBand[] {
  const { m, intensity } = laneProfile(img, center, halfWidth);
  const totalLength = curveMetric(center).totalLength;
  const n = m.length;
  const threshold = params.bandThreshold;
  const minGapM = params.minPeakDistance / totalLength;

  const peaks: number[] = [];
  for (let i = 1; i < n - 1; i++) {
    if (intensity[i] >= threshold && intensity[i] >= intensity[i - 1] && intensity[i] >= intensity[i + 1]) {
      peaks.push(i);
    }
  }
  const spaced: number[] = [];
  for (const p of peaks) {
    if (!spaced.length || m[p] - m[spaced[spaced.length - 1]] >= minGapM) spaced.push(p);
    else if (intensity[p] > intensity[spaced[spaced.length - 1]]) spaced[spaced.length - 1] = p;
  }

  const out: RawBand[] = [];
  let i = 0;
  while (i < spaced.length) {
    let j = i;
    // 合并过近且谷底不够深的峰 => 两条带重叠
    const group = [spaced[i]];
    while (j + 1 < spaced.length && m[spaced[j + 1]] - m[spaced[j]] < minGapM * 2.4) {
      const valley = minBetween(intensity, spaced[j], spaced[j + 1]);
      const peakMin = Math.min(intensity[spaced[j]], intensity[spaced[j + 1]]);
      if (valley > params.overlapValleyRatio * peakMin) {
        group.push(spaced[j + 1]);
        j++;
      } else break;
    }
    const i0 = group[0];
    const i1 = group[group.length - 1];
    const mLo = m[leftBase(intensity, i0, threshold)];
    const mHi = m[rightBase(intensity, i1, threshold)];
    const apex = group.length > 1 ? weightedApex(intensity, group) : i0;
    const apexM = m[apex];
    const centerPx = pointAtM(center, apexM);

    const maxIntensity = maxAround(intensity, apex);
    const saturated = maxIntensity >= params.saturationFloor;
    const halfW = halfWidthAtM(intensity, apex, m) * totalLength;
    const smeared = halfW > params.smearWidthMax || (mHi - mLo) * totalLength > params.smearWidthMax * 2.4;

    const p0 = pointAtM(center, mLo);
    const p1 = pointAtM(center, mHi);
    const band: RawBand = {
      centerPx,
      box: { x0: Math.round(Math.min(p0.x, p1.x, centerPx.x) - halfWidth), y0: Math.round(centerPx.y - halfW), x1: Math.round(Math.max(p0.x, p1.x, centerPx.x) + halfWidth), y1: Math.round(centerPx.y + halfW) },
      m: apexM,
      intensity: maxIntensity,
      halfWidthPx: halfW,
      saturated,
      smeared,
      smearMRange: smeared ? { mLo, mHi } : undefined,
      merged: group.length > 1,
      mRange: group.length > 1 ? { mLo, mHi } : undefined,
    };
    if (saturated) {
      const { lo, hi } = plateauRange(intensity, m, apex, params.saturationFloor);
      band.plateauMRange = { mLo: lo, mHi: hi };
      band.box.y0 = Math.round(pointAtM(center, lo).y);
      band.box.y1 = Math.round(pointAtM(center, hi).y);
    }
    out.push(band);
    i = j + 1;
  }
  return out;
}

function minBetween(a: Float64Array, i: number, j: number): number {
  let v = Infinity;
  for (let k = i; k <= j; k++) v = Math.min(v, a[k]);
  return v;
}
function leftBase(a: Float64Array, i: number, t: number): number {
  let k = i;
  while (k > 0 && a[k - 1] >= t * 0.5) k--;
  return k;
}
function rightBase(a: Float64Array, i: number, t: number): number {
  let k = i;
  while (k < a.length - 1 && a[k + 1] >= t * 0.5) k++;
  return k;
}
function weightedApex(a: Float64Array, group: number[]): number {
  let sw = 0;
  let s = 0;
  for (const g of group) {
    s += g * a[g];
    sw += a[g];
  }
  return Math.round(s / sw);
}
function maxAround(a: Float64Array, i: number): number {
  let v = a[i];
  for (let k = Math.max(0, i - 2); k <= Math.min(a.length - 1, i + 2); k++) v = Math.max(v, a[k]);
  return v;
}
function halfWidthAtM(a: Float64Array, i: number, m: Float64Array): number {
  const half = a[i] * 0.5;
  let l = i;
  let r = i;
  while (l > 0 && a[l] > half) l--;
  while (r < a.length - 1 && a[r] > half) r++;
  return Math.abs(m[r] - m[l]) / 2;
}
function plateauRange(a: Float64Array, m: Float64Array, i: number, floor: number) {
  let l = i;
  let r = i;
  while (l > 0 && a[l - 1] >= floor) l--;
  while (r < a.length - 1 && a[r + 1] >= floor) r++;
  return { lo: m[l], hi: m[r] };
}

export { projectToCurve, clamp };
