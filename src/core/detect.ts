// 自动候选检测：全部输出保留像素帧来源；检测不产生“结论”，只产生候选与证据。
import { toGray, type RawImage } from './png';
import {
  nearestOnPolyline,
  pointOnPolyline,
  polylineArcLength,
  type Vec2
} from './geometry';
import type { ParameterSet, PixelPoint } from '../shared/types';

export interface DetectedLane {
  laneIndex: number;
  centerline: Vec2[];
  leftBoundary: Vec2[];
  rightBoundary: Vec2[];
  isLadder: boolean;
}

export interface ProfilePoint {
  m: number;
  i: number;
}

export interface DetectedBand {
  laneIndex: number;
  bandIndex: number;
  peak: Vec2; // 像素中心
  migration: number; // 沿中心线弧长 px
  peakIntensity: number;
  fwhmPx: number;
  saturated: boolean;
  smear: boolean;
  overlapGroupId: string | null;
  residualToCenterPx: number;
  profileSample: { m: number; i: number }[];
}

/** 列投影粗检 lane 位置（亮胶暗带 -> 反色强度按列求和）。 */
export function detectLanePositions(
  img: RawImage,
  opts: { minGapPx?: number; bandBand?: { y0: number; y1: number } } = {}
): { x: number; strength: number }[] {
  const { inverted } = toGray(img);
  const y0 = opts.bandBand?.y0 ?? Math.round(img.height * 0.05);
  const y1 = opts.bandBand?.y1 ?? Math.round(img.height * 0.95);
  const col = new Float64Array(img.width);
  for (let x = 0; x < img.width; x++) {
    let sum = 0;
    for (let y = y0; y < y1; y++) sum += inverted[y * img.width + x];
    col[x] = sum / (y1 - y0);
  }
  const threshold = Math.min(...col) + (Math.max(...col) - Math.min(...col)) * 0.15;
  const lanes: { x: number; strength: number }[] = [];
  const minGap = opts.minGapPx ?? 40;
  for (let x = 1; x < img.width - 1; x++) {
    if (col[x] > threshold && col[x] >= col[x - 1] && col[x] >= col[x + 1]) {
      const last = lanes[lanes.length - 1];
      if (!last || x - last.x > minGap) lanes.push({ x, strength: col[x] });
      else if (col[x] > last.strength) lanes[lanes.length - 1] = { x, strength: col[x] };
    }
  }
  return lanes;
}

/** 逐行质心细化中心线（捕捉“微笑”弯曲），边界 = 中心线 ± lane 半宽。 */
export function refineLaneCurve(
  img: RawImage,
  x0: number,
  halfWidth: number,
  laneIndex: number,
  isLadder: boolean
): DetectedLane {
  const { inverted } = toGray(img);
  const center: Vec2[] = [];
  for (let y = 2; y < img.height - 2; y += 2) {
    let num = 0;
    let den = 0;
    for (let dx = -halfWidth; dx <= halfWidth; dx++) {
      const xi = x0 + dx;
      if (xi < 0 || xi >= img.width) continue;
      const v = inverted[y * img.width + xi];
      num += xi * v;
      den += v;
    }
    const cx = den > 0 ? num / den : x0;
    center.push({ x: cx, y });
  }
  // 简单滑动平均去噪
  for (let pass = 0; pass < 2; pass++) {
    for (let i = 1; i < center.length - 1; i++) {
      center[i] = { x: (center[i - 1].x + center[i].x + center[i + 1].x) / 3, y: center[i].y };
    }
  }
  const leftBoundary = center.map((p) => ({ x: p.x - halfWidth, y: p.y }));
  const rightBoundary = center.map((p) => ({ x: p.x + halfWidth, y: p.y }));
  return { laneIndex, centerline: center, leftBoundary, rightBoundary, isLadder };
}

/** 沿 lane 中心线做弧长 -> 横截面平均强度的轮廓。 */
export function laneProfile(
  img: RawImage,
  centerline: Vec2[],
  halfWidth: number,
  stepPx = 1
): ProfilePoint[] {
  const { inverted, gray } = toGray(img);
  const length = polylineArcLength(centerline);
  const out: ProfilePoint[] = [];
  for (let m = 0; m <= length; m += stepPx) {
    const p = pointOnPolyline(centerline, m);
    let sum = 0;
    let n = 0;
    for (let dx = -halfWidth; dx <= halfWidth; dx += 2) {
      const xi = Math.round(p.x + dx);
      const yi = Math.round(p.y);
      if (xi >= 0 && xi < img.width && yi >= 0 && yi < img.height) {
        sum += inverted[yi * img.width + xi];
        n++;
      }
    }
    out.push({ m, i: n ? sum / n : 0 });
    void gray;
  }
  return out;
}

export interface Peak {
  index: number;
  m: number;
  height: number; // 去基线后
  fwhm: number;
  base: number;
}

export function findPeaks(profile: ProfilePoint[], prominence: number): Peak[] {
  if (profile.length < 5) return [];
  // 移动最小值作为基线
  const win = 25;
  const base = profile.map((_, i) => {
    const lo = Math.max(0, i - win);
    const hi = Math.min(profile.length, i + win + 1);
    let b = Infinity;
    for (let j = lo; j < hi; j++) b = Math.min(b, profile[j].i);
    return b;
  });
  const h = profile.map((p, i) => p.i - base[i]);
  const peaks: Peak[] = [];
  for (let i = 2; i < profile.length - 2; i++) {
    if (h[i] < prominence) continue;
    if (h[i] > h[i - 1] && h[i] >= h[i + 1]) {
      const half = h[i] / 2;
      let l = i;
      while (l > 0 && h[l] > half) l--;
      let r = i;
      while (r < h.length - 1 && h[r] > half) r++;
      peaks.push({
        index: i,
        m: profile[i].m,
        height: h[i],
        fwhm: profile[r].m - profile[l].m,
        base: base[i]
      });
    }
  }
  return peaks;
}

/** 饱和判定：峰附近是否存在达到饱和阈值的像素（反色后）。 */
function peakSaturated(img: RawImage, p: Vec2, halfWidth: number, threshold: number): boolean {
  const { inverted } = toGray(img);
  for (let dy = -3; dy <= 3; dy++) {
    for (let dx = -halfWidth; dx <= halfWidth; dx++) {
      const xi = Math.round(p.x + dx);
      const yi = Math.round(p.y + dy);
      if (xi >= 0 && xi < img.width && yi >= 0 && yi < img.height) {
        if (inverted[yi * img.width + xi] >= threshold) return true;
      }
    }
  }
  return false;
}

export function detectBands(
  img: RawImage,
  lane: DetectedLane,
  params: ParameterSet
): DetectedBand[] {
  const halfWidth = Math.round(
    (lane.rightBoundary[0].x - lane.leftBoundary[0].x) / 2
  );
  const profile = laneProfile(img, lane.centerline, halfWidth);
  const peaks = findPeaks(profile, params.peakProminence);
  const length = polylineArcLength(lane.centerline);

  // 重叠分组：峰间距小于两峰半高宽之和的 0.9
  const parent = peaks.map((_, i) => i);
  const find = (a: number): number => {
    while (parent[a] !== a) a = parent[a] = parent[parent[a]];
    return a;
  };
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < peaks.length; j++) {
      const sep = peaks[j].m - peaks[i].m;
      if (sep < ((peaks[i].fwhm + peaks[j].fwhm) / 2) * 0.9) parent[find(j)] = find(i);
    }
  }
  const groupSize = new Map<number, number>();
  peaks.forEach((_, i) => groupSize.set(find(i), (groupSize.get(find(i)) ?? 0) + 1));

  const widths = peaks.map((p) => p.fwhm).sort((a, b) => a - b);
  const medianWidth = widths[Math.floor(widths.length / 2)] ?? 4;

  return peaks.map((peak, bandIndex) => {
    const peakPoint: Vec2 = pointOnPolyline(lane.centerline, peak.m);
    const root = find(bandIndex);
    const overlap = (groupSize.get(root) ?? 1) > 1;
    const saturated = peakSaturated(img, peakPoint, halfWidth, params.saturationThreshold);
    const smear = peak.fwhm > medianWidth * params.fwhmSmearFactor && !overlap;
    return {
      laneIndex: lane.laneIndex,
      bandIndex,
      peak: peakPoint,
      migration: peak.m,
      peakIntensity: Math.round(peak.height + peak.base),
      fwhmPx: peak.fwhm,
      saturated,
      smear,
      overlapGroupId: overlap ? `g${lane.laneIndex}-${root}` : null,
      residualToCenterPx: 0,
      profileSample: profile
        .filter((_, i) => i % 2 === 0)
        .map((p) => ({ m: +p.m.toFixed(2), i: Math.round(p.i) }))
    };
  });
}

export function toPixelPoint(p: Vec2): PixelPoint {
  return { x: +p.x.toFixed(2), y: +p.y.toFixed(2) };
}
