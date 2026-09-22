import type { GrayImage } from './png';
import type { CalibrationParams } from './types';
import type { Pt } from '../shared/geometry';
import type { Diagnostic } from '../shared/diagnostics';
import { cumulativeLength, pointAtLength } from '../shared/geometry';
import { diag } from '../shared/diagnostics';

export interface ProfilePoint {
  sPx: number;
  intensity: number;
  saturatedFraction: number;
}

export interface DetectedBand {
  index: number;
  sPx: number;
  center: Pt;
  peakIntensity: number;
  widthHalfMaxPx: number;
  saturatedFraction: number;
  flag: 'normal' | 'saturated' | 'smear' | 'overlap';
  clusterId: number;
}

export interface DetectionResult {
  laneId: string;
  profile: ProfilePoint[];
  bands: DetectedBand[];
  diagnostics: Diagnostic[];
}

/** 沿弯曲泳道中心线取剖面；对每个弧长截面做垂直宽度内的像素聚合。 */
export function laneProfile(img: GrayImage, centerline: Pt[], halfWidth: number, params: CalibrationParams): ProfilePoint[] {
  const total = cumulativeLength(centerline)[centerline.length - 1];
  const profile: ProfilePoint[] = [];
  let segIdx = 1;
  const cum = cumulativeLength(centerline);
  for (let s = 0; s <= total; s += 1) {
    while (segIdx < centerline.length - 1 && cum[segIdx] < s) segIdx++;
    const a = centerline[segIdx - 1];
    const b = centerline[segIdx];
    const base = pointAtLength(centerline, s);
    if (!base) continue;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    const ny = dx / len;
    let peak = 0;
    let satCount = 0;
    let count = 0;
    for (let w = -halfWidth; w <= halfWidth; w += 2) {
      const x = Math.round(base.x + nx * w);
      const y = Math.round(base.y + ny * w);
      if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
      const v = img.pixels[y * img.width + x];
      if (v > peak) peak = v;
      count++;
      if (v >= params.saturationThreshold) satCount++;
    }
    profile.push({ sPx: s, intensity: peak, saturatedFraction: count ? satCount / count : 0 });
  }
  return profile;
}

function smooth(p: ProfilePoint[], radius = 3): ProfilePoint[] {
  const out = new Array<ProfilePoint>(p.length);
  for (let i = 0; i < p.length; i++) {
    let sum = 0;
    let sat = 0;
    let n = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < p.length) {
        sum += p[j].intensity;
        sat += p[j].saturatedFraction;
        n++;
      }
    }
    out[i] = { sPx: p[i].sPx, intensity: sum / n, saturatedFraction: sat / n };
  }
  return out;
}

function valleyBetween(p: ProfilePoint[], i: number, j: number): number {
  let m = Infinity;
  for (let k = Math.min(i, j) + 1; k < Math.max(i, j); k++) m = Math.min(m, p[k].intensity);
  return m;
}

function halfMaxWidth(p: ProfilePoint[], idx: number, base: number): number {
  const peak = p[idx].intensity;
  const half = (peak + base) / 2;
  let lo = idx;
  let hi = idx;
  while (lo > 0 && p[lo - 1].intensity > half) lo--;
  while (hi < p.length - 1 && p[hi + 1].intensity > half) hi++;
  return (p[hi].sPx - p[lo].sPx) / 2;
}

function localBase(p: ProfilePoint[], idx: number): number {
  let m = Infinity;
  const r = 30;
  for (let k = Math.max(0, idx - r); k <= Math.min(p.length - 1, idx + r); k++) m = Math.min(m, p[k].intensity);
  return m;
}

export function detectBands(
  img: GrayImage,
  laneId: string,
  centerline: Pt[],
  halfWidth: number,
  params: CalibrationParams
): DetectionResult {
  const diagnostics: Diagnostic[] = [];
  const raw = laneProfile(img, centerline, halfWidth, params);
  const profile = smooth(raw);

  const rawPeaks: { idx: number; s: number; intensity: number }[] = [];
  for (let i = 3; i < profile.length - 3; i++) {
    const v = profile[i].intensity;
    if (
      v >= profile[i - 1].intensity &&
      v >= profile[i + 1].intensity &&
      v >= profile[i - 2].intensity &&
      v >= profile[i + 2].intensity
    ) {
      const base = localBase(profile, i);
      if (v - base >= params.minPeakProminence) {
        rawPeaks.push({ idx: i, s: profile[i].sPx, intensity: v });
      }
    }
  }

  // 非极大值合并：相邻 6px 内的局部平台只保留最大点。
  const peaks: typeof rawPeaks = [];
  for (const pk of rawPeaks) {
    const last = peaks[peaks.length - 1];
    if (last && pk.s - last.s < 6) {
      if (pk.intensity > last.intensity) peaks[peaks.length - 1] = pk;
    } else {
      peaks.push(pk);
    }
  }

  // 重叠聚类：相邻真实峰间距小于阈值且谷底未分开（< 70% 较低峰高），无法唯一归属。
  const clusterOf = peaks.map(() => -1);
  let clusterCount = 0;
  for (let i = 0; i < peaks.length; i++) {
    if (clusterOf[i] === -1) clusterOf[i] = clusterCount++;
    if (i + 1 < peaks.length) {
      const a = peaks[i];
      const b = peaks[i + 1];
      const valley = valleyBetween(profile, a.idx, b.idx);
      const threshold = Math.min(a.intensity, b.intensity) * 0.7;
      if (b.s - a.s < params.overlapDistancePx && valley > threshold) {
        clusterOf[i + 1] = clusterOf[i];
      }
    }
  }
  const clusterSize = new Map<number, number>();
  for (const c of clusterOf) clusterSize.set(c, (clusterSize.get(c) ?? 0) + 1);

  const bands: DetectedBand[] = peaks.map((pk, i) => {
    const center = pointAtLength(centerline, pk.s) ?? centerline[centerline.length - 1];
    const satFrac = Math.max(
      raw[pk.idx]?.saturatedFraction ?? 0,
      profile[pk.idx]?.saturatedFraction ?? 0
    );
    const base = localBase(profile, pk.idx);
    const width = halfMaxWidth(profile, pk.idx, base);
    const saturated = satFrac > 0.35 || pk.intensity >= params.saturationThreshold;
    const overlap = (clusterSize.get(clusterOf[i]) ?? 0) > 1;
    const smear = !overlap && width >= 11;
    const flag: DetectedBand['flag'] = saturated ? 'saturated' : overlap ? 'overlap' : smear ? 'smear' : 'normal';
    if (saturated) {
      diagnostics.push(
        diag('BAND_SATURATED', 'SEMANTIC_UNRESOLVABLE', `泳道 ${laneId} 中 s=${Math.round(pk.s)}px 的条带饱和，只能给区间/候选`, [
          { material: laneId, pixel: { x: Math.round(center.x), y: Math.round(center.y), frame: img.frameId } }
        ], 'warning')
      );
    }
    if (smear) {
      diagnostics.push(
        diag('BAND_SMEAR', 'SEMANTIC_UNRESOLVABLE', `泳道 ${laneId} 中 s=${Math.round(pk.s)}px 为拖尾条带，只能标为候选或区间`, [
          { material: laneId, pixel: { x: Math.round(center.x), y: Math.round(center.y), frame: img.frameId } }
        ], 'warning')
      );
    }
    return {
      index: i,
      sPx: pk.s,
      center,
      peakIntensity: Math.round(pk.intensity),
      widthHalfMaxPx: Math.round(width * 10) / 10,
      saturatedFraction: Math.round(satFrac * 1000) / 1000,
      flag,
      clusterId: clusterOf[i]
    };
  });

  const seen = new Set<number>();
  for (const b of bands) {
    if (b.flag === 'overlap' && !seen.has(b.clusterId)) {
      seen.add(b.clusterId);
      diagnostics.push(
        diag('BAND_OVERLAP', 'SEMANTIC_UNRESOLVABLE', `泳道 ${laneId} 存在重叠条带簇 #${b.clusterId}，保留全部合法候选`, [
          { material: laneId, pixel: { x: Math.round(b.center.x), y: Math.round(b.center.y), frame: img.frameId } }
        ], 'warning')
      );
    }
  }

  return { laneId, profile, bands, diagnostics };
}

export function projectBandToLane(center: Pt, centerline: Pt[]): number {
  const cum = cumulativeLength(centerline);
  return Math.round((cum[cum.length - 1] ? center.y : center.y) * 10) / 10;
}

export function clampPt(p: { x: number; y: number }, w: number, h: number) {
  return { x: Math.max(0, Math.min(w - 1, p.x)), y: Math.max(0, Math.min(h - 1, p.y)) };
}
