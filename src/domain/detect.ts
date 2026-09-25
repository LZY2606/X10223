import type { BandEvidence, ControlPoint } from '../shared/types.js';

export interface DetectionParams {
  laneBandHalfWidth: number;
  laneSearchHalfWidth: number;
  laneMinSeparationPx: number;
  bandThreshold: number;
  bandMinProminence: number;
  bandMinSeparationPx: number;
  overlapMinSeparationPx: number;
  saturationGray: number;
  smearBandWidthFactor: number;
  backgroundGray: number;
}

export const DEFAULT_DETECTION: DetectionParams = {
  laneBandHalfWidth: 16,
  laneSearchHalfWidth: 26,
  laneMinSeparationPx: 34,
  bandThreshold: 70,
  bandMinProminence: 35,
  bandMinSeparationPx: 8,
  overlapMinSeparationPx: 14,
  saturationGray: 250,
  smearBandWidthFactor: 2.4,
  backgroundGray: 60,
};

export interface DetectedLane {
  ordinal: number;
  x0: number;
  points: ControlPoint[];
  strength: number;
}

export interface ProfilePoint {
  s: number;
  x: number;
  y: number;
  intensity: number;
  saturatedFraction: number;
}

export interface DetectedBand {
  id: number;
  s: number;
  x: number;
  y: number;
  intensityPeak: number;
  widthPx: number;
  heightPx: number;
  areaPx: number;
  saturated: boolean;
  saturationFraction: number;
  smeared: boolean;
  smearExtentPx: number;
  profile: { s: number; intensity: number }[];
  overlapPeerIds: number[];
}

function findPeaks(series: number[], minProminence: number, minSeparation: number, threshold: number): number[] {
  const peaks: number[] = [];
  for (let i = 1; i < series.length - 1; i++) {
    if (series[i]! >= threshold && series[i]! >= series[i - 1]! && series[i]! >= series[i + 1]!) {
      const leftBase = Math.min(...series.slice(Math.max(0, i - 30), i + 1));
      const rightBase = Math.min(...series.slice(i, Math.min(series.length, i + 31)));
      const prominence = series[i]! - Math.max(leftBase, rightBase);
      if (prominence >= minProminence) peaks.push(i);
    }
  }
  const picked: number[] = [];
  for (const p of peaks) {
    if (picked.length === 0 || p - picked[picked.length - 1]! >= minSeparation) {
      picked.push(p);
    } else if (series[p]! > series[picked[picked.length - 1]!]!) {
      picked[picked.length - 1] = p;
    }
  }
  return picked;
}

export function detectLanes(gray: Uint8Array, w: number, h: number, params: DetectionParams = DEFAULT_DETECTION): DetectedLane[] {
  const y0 = Math.floor(h * 0.05);
  const y1 = Math.floor(h * 0.95);
  const colScore: number[] = new Array(w).fill(0);
  for (let x = 0; x < w; x++) {
    let acc = 0;
    for (let y = y0; y < y1; y++) {
      const v = gray[y * w + x]!;
      if (v > params.bandThreshold) acc += (v - params.bandThreshold) ** 1.5;
    }
    colScore[x] = acc / (y1 - y0);
  }
  const xPeaks = findPeaks(colScore.map((v) => Math.round(v)), 120, params.laneMinSeparationPx, 100);
  const lanes: DetectedLane[] = [];
  xPeaks.forEach((x0, ordinal) => {
    const points: ControlPoint[] = [];
    let xCenter = x0;
    const step = 6;
    for (let y = 4; y <= h - 4; y += step) {
      let num = 0;
      let den = 0;
      for (let dx = -params.laneSearchHalfWidth; dx <= params.laneSearchHalfWidth; dx++) {
        const xx = Math.round(xCenter) + dx;
        if (xx < 0 || xx >= w) continue;
        const v = gray[y * w + xx]!;
        const weight = Math.max(0, v - params.backgroundGray);
        num += xx * weight;
        den += weight;
      }
      if (den > 0) xCenter = num / den;
      points.push({ x: Math.round(xCenter * 100) / 100, y });
    }
    lanes.push({ ordinal, x0, points, strength: colScore[x0]! });
  });
  return lanes.sort((a, b) => {
    const ax = a.points[Math.floor(a.points.length / 2)]?.x ?? a.x0;
    const bx = b.points[Math.floor(b.points.length / 2)]?.x ?? b.x0;
    return ax - bx;
  });
}

export function laneProfile(
  gray: Uint8Array,
  w: number,
  h: number,
  points: ControlPoint[],
  params: DetectionParams = DEFAULT_DETECTION,
): ProfilePoint[] {
  const out: ProfilePoint[] = [];
  for (const p of points) {
    let sum = 0;
    let saturated = 0;
    let count = 0;
    let best = 0;
    for (let dx = -params.laneBandHalfWidth; dx <= params.laneBandHalfWidth; dx++) {
      const x = Math.round(p.x + dx);
      const y = p.y;
      if (x < 0 || y < 0 || x >= w || y >= h) continue;
      const v = gray[y * w + x]!;
      sum += v;
      count++;
      best = Math.max(best, v);
      if (v >= params.saturationGray) saturated++;
    }
    out.push({
      s: p.y,
      x: p.x,
      y: p.y,
      intensity: count ? sum / count : 0,
      saturatedFraction: count ? saturated / count : 0,
    });
  }
  return out;
}

function estimateBaseline(profile: ProfilePoint[]): number[] {
  const window = 25;
  return profile.map((_, i) => {
    const lo = Math.max(0, i - window);
    const hi = Math.min(profile.length, i + window);
    let count = 0;
    let sum = 0;
    for (let j = lo; j < hi; j++) {
      if (profile[j]!.intensity < 80) {
        sum += profile[j]!.intensity;
        count++;
      }
    }
    return count ? sum / count : 40;
  });
}

export function detectBands(
  gray: Uint8Array,
  w: number,
  h: number,
  points: ControlPoint[],
  params: DetectionParams = DEFAULT_DETECTION,
): DetectedBand[] {
  const profile = laneProfile(gray, w, h, points, params);
  const baseline = estimateBaseline(profile);
  const corrected = profile.map((p, i) => Math.max(0, p.intensity - baseline[i]!));
  const peakIdx = findPeaks(corrected.map((v) => Math.round(v)), params.bandMinProminence, params.bandMinSeparationPx, params.bandThreshold - 40);
  const bands: DetectedBand[] = peakIdx.map((idx, id) => {
    const half = Math.max(params.bandMinSeparationPx, 6);
    const segStart = Math.max(0, idx - half);
    const segEnd = Math.min(corrected.length, idx + half + 1);
    let area = 0;
    let sat = 0;
    let satTotal = 0;
    for (let j = segStart; j < segEnd; j++) {
      area += corrected[j]!;
      satTotal++;
      if (profile[j]!.saturatedFraction > 0.2) sat++;
    }
    let lo = idx;
    while (lo > segStart && corrected[lo]! > corrected[idx]! * 0.5) lo--;
    let hi = idx;
    while (hi < segEnd - 1 && corrected[hi]! > corrected[idx]! * 0.5) hi++;
    const widthPx = Math.max(6, (hi - lo) * 6);
    const heightPx = 10;
    const saturated = profile[idx]!.saturatedFraction > 0.2 || corrected[idx]! >= 250 - 20;
    const smeared = widthPx > params.laneBandHalfWidth * params.smearBandWidthFactor;
    const profileData = profile.slice(segStart, segEnd).map((p, k) => ({ s: p.s, intensity: Math.round(corrected[segStart + k]! * 10) / 10 }));
    return {
      id,
      s: profile[idx]!.s,
      x: profile[idx]!.x,
      y: profile[idx]!.y,
      intensityPeak: Math.round((profile[idx]!.intensity) * 10) / 10,
      widthPx,
      heightPx,
      areaPx: Math.round(area),
      saturated,
      saturationFraction: Math.round((sat / Math.max(1, satTotal)) * 100) / 100,
      smeared,
      smearExtentPx: smeared ? widthPx : 0,
      profile: profileData,
      overlapPeerIds: [],
    };
  });

  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const sep = Math.abs(bands[j]!.s - bands[i]!.s);
      if (sep < params.overlapMinSeparationPx) {
        bands[i]!.overlapPeerIds.push(j);
        bands[j]!.overlapPeerIds.push(i);
      }
    }
  }
  return bands;
}

export function buildBandEvidence(
  b: DetectedBand,
  imageId: string,
  frame: string,
  sourceEventId: string,
): BandEvidence {
  return {
    center: { imageId, x: b.x, y: b.s, frame, sourceEventId, raw: { x: b.x, y: b.s } },
    sOnLane: b.s,
    intensityPeak: { value: b.intensityPeak, unit: 'grayvalue' },
    areaPx: b.areaPx,
    shape: { widthPx: b.widthPx, heightPx: b.heightPx },
    saturated: b.saturated,
    saturationFraction: b.saturationFraction,
    smeared: b.smeared,
    smearExtentPx: b.smearExtentPx,
    profile: b.profile,
  };
}
