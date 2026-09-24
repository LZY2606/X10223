import type { AnalysisParams, Diagnostic, LaneGeom, Result } from './types';
import { failed, ok } from './types';
import type { GelImage } from './gelimage';
import { curveY } from './ruler';

export interface DetectedBand {
  bandId: string;
  laneId: string;
  xPx: number;
  yPx: number;
  kind: 'point' | 'interval' | 'overlap-set';
  centerRangePx?: [number, number];
  hypotheses?: { members: { xPx: number; yPx: number }[] }[];
  quality: { saturated: boolean; tailing: boolean; overlap: boolean };
  diagnostics: Diagnostic[];
}

export function laneProfile(img: GelImage, lane: LaneGeom): Float64Array {
  const { width, height, gray } = img;
  const out = new Float64Array(height);
  const x = Math.round(lane.xPx);
  const half = Math.max(1, Math.floor(lane.widthPx / 6));
  for (let y = 0; y < height; y++) {
    const yy = Math.round(y + curveY(lane, x) - curveY(lane, lane.xPx));
    let acc = 0;
    let n = 0;
    for (let dx = -half; dx <= half; dx++) {
      const xx = x + dx;
      if (xx < 0 || xx >= width || yy < 0 || yy >= height) continue;
      acc += gray[yy * width + xx]!;
      n++;
    }
    out[y] = n > 0 ? acc / n : 0;
  }
  return out;
}

interface Peak {
  y: number;
  height: number;
  left: number;
  right: number;
  saturated: boolean;
  plateau: [number, number];
}

function findPeaks(profile: Float64Array, params: AnalysisParams): Peak[] {
  const peaks: Peak[] = [];
  const n = profile.length;
  const base = 12;
  for (let y = 2; y < n - 2; y++) {
    const v = profile[y]!;
    if (v < base + params.peakProminence) continue;
    if (v < profile[y - 1]! || v <= profile[y + 1]!) continue;
    let left = y;
    while (left > 0 && profile[left - 1]! > base) left--;
    let right = y;
    while (right < n - 1 && profile[right + 1]! > base) right++;
    let pl = y;
    let pr = y;
    let saturated = false;
    if (v >= params.saturationThreshold) {
      saturated = true;
      while (pl > 0 && profile[pl - 1]! >= params.saturationThreshold) pl--;
      while (pr < n - 1 && profile[pr + 1]! >= params.saturationThreshold) pr++;
    }
    const existing = peaks[peaks.length - 1];
    if (existing && y - existing.y < 3) {
      if (v > existing.height) {
        peaks[peaks.length - 1] = { y, height: v, left, right, saturated, plateau: [pl, pr] };
      }
      continue;
    }
    peaks.push({ y, height: v, left, right, saturated, plateau: [pl, pr] });
  }
  return peaks;
}

export function detectBands(
  img: GelImage,
  lane: LaneGeom,
  params: AnalysisParams,
): Result<DetectedBand[]> {
  const diagnostics: Diagnostic[] = [];
  const profile = laneProfile(img, lane);
  const peaks = findPeaks(profile, params);
  if (peaks.length > params.maxPeaksPerLane) {
    return failed('BUDGET_EXHAUSTED', [
      {
        code: 'BUDGET_PEAKS',
        message: `泳道 ${lane.laneId} 检出峰 ${peaks.length} 个，超过预算 ${params.maxPeaksPerLane}`,
        location: `bands.${lane.laneId}`,
        severity: 'error',
      },
    ]);
  }
  const bands: DetectedBand[] = [];
  const dy = curveY(lane, Math.round(lane.xPx));
  for (let i = 0; i < peaks.length; i++) {
    const p = peaks[i]!;
    const bandId = `${lane.laneId}-b${i + 1}`;
    const bd: Diagnostic[] = [];
    const widthPx = p.right - p.left;
    const next = peaks[i + 1];
    const prev = peaks[i - 1];
    const closeTo =
      (next && next.y - p.y < params.overlapMinSeparationPx) ||
      (prev && p.y - prev.y < params.overlapMinSeparationPx);
    const leftHw = p.y - p.left;
    const rightHw = p.right - p.y;
    const asym = rightHw / Math.max(1, leftHw);
    const tailing = asym > params.tailingAsymmetryRatio;

    if (closeTo && next && next.y - p.y < params.overlapMinSeparationPx) {
      const lo = Math.min(p.y, next.y);
      const hi = Math.max(p.y, next.y);
      bands.push({
        bandId,
        laneId: lane.laneId,
        xPx: lane.xPx,
        yPx: (lo + hi) / 2 + dy,
        kind: 'overlap-set',
        centerRangePx: [lo + dy, hi + dy],
        hypotheses: [
          { members: [{ xPx: lane.xPx, yPx: (lo + hi) / 2 + dy }] },
          {
            members: [
              { xPx: lane.xPx, yPx: lo + dy },
              { xPx: lane.xPx, yPx: hi + dy },
            ],
          },
        ],
        quality: { saturated: false, tailing: false, overlap: true },
        diagnostics: [
          {
            code: 'OVERLAP_AMBIGUOUS',
            message: `条带 ${bandId} 存在重叠，保留全部合法候选（单宽峰 / 双峰），只能标为候选`,
            location: `bands.${lane.laneId}.${bandId}`,
            severity: 'warning',
          },
        ],
      });
      i++;
      continue;
    }
    if (p.saturated || tailing) {
      const range: [number, number] = p.saturated
        ? [p.plateau[0] + dy, p.plateau[1] + dy]
        : [p.y - leftHw + dy, p.y + rightHw + dy];
      bands.push({
        bandId,
        laneId: lane.laneId,
        xPx: lane.xPx,
        yPx: (range[0] + range[1]) / 2,
        kind: 'interval',
        centerRangePx: range,
        quality: { saturated: p.saturated, tailing, overlap: false },
        diagnostics: [
          {
            code: p.saturated ? 'SATURATED_INTERVAL_ONLY' : 'TAILING_INTERVAL_ONLY',
            message: `条带 ${bandId} ${p.saturated ? '饱和' : '拖尾'}，中心不确定，只能标为区间`,
            location: `bands.${lane.laneId}.${bandId}`,
            severity: 'warning',
          },
        ],
      });
      continue;
    }
    if (widthPx < 2) {
      bd.push({
        code: 'WEAK_BAND',
        message: `条带 ${bandId} 信号弱`,
        location: `bands.${lane.laneId}.${bandId}`,
        severity: 'warning',
      });
    }
    bands.push({
      bandId,
      laneId: lane.laneId,
      xPx: lane.xPx,
      yPx: p.y + dy,
      kind: 'point',
      quality: { saturated: false, tailing: false, overlap: false },
      diagnostics: bd,
    });
  }
  return ok(bands, diagnostics);
}
