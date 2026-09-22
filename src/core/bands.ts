import type { RawImage } from './png';
import type { Budget } from './detect';
import { checkBudget, grayAt, type DetectedLane } from './detect';
import { pointAtArcLength } from './geometry';
import { GelFailure, diag } from './errors';
import { PARAM_VERSIONS, DEFAULT_PARAMS } from './params';
import type { Diagnostic } from '../shared/types';

export interface DetectedBand {
  laneOrdinal: number;
  tArcPx: number;
  x: number;
  y: number;
  peak: number;
  background: number;
  area: number;
  widthPx: number;
  saturated: boolean;
  tailing: boolean;
  tailingScore: number;
  diagnostics: Diagnostic[];
}

/** 沿 lane 中心线按弧长做条带剖面（横向取半宽平均） */
export function laneProfile(img: RawImage, lane: DetectedLane, step = 1): { t: number; v: number; x: number; y: number }[] {
  const out: { t: number; v: number; x: number; y: number }[] = [];
  for (let t = 2; t < lane.totalLength - 2; t += step) {
    const { point, tangent } = pointAtArcLength(lane.poly, lane.table, t);
    const nx = -tangent.y;
    const ny = tangent.x;
    let sum = 0;
    let count = 0;
    for (let w = -lane.halfWidthPx + 2; w <= lane.halfWidthPx - 2; w += 2) {
      sum += grayAt(img, point.x + nx * w, point.y + ny * w);
      count++;
    }
    out.push({ t, v: count ? sum / count : 0, x: point.x, y: point.y });
  }
  return out;
}

function estimateBackground(profile: { v: number }[]): number {
  const vals = profile.map((p) => p.v).sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.15)] ?? 0;
}

interface RawPeak {
  index: number;
  /** 两个最小谷之间的区段 */
  i0: number;
  i1: number;
  max: number;
  plateau: boolean;
}

/** 饱和平台峰的拆分：平台中心 + 平台两侧斜坡的子峰 */
function splitSaturatedPlateau(profile: { t: number; v: number }[], p: RawPeak): RawPeak[] {
  const level = profile[p.index].v;
  const flat: number[] = [];
  for (let i = p.i0; i <= p.i1; i++) if (profile[i].v >= level - 1) flat.push(i);
  if (flat.length < 6) return [p];
  const f0 = flat[0];
  const f1 = flat[flat.length - 1];
  const make = (i0: number, i1: number): RawPeak => {
    let best = i0;
    for (let i = i0; i <= i1; i++) if (profile[i].v > profile[best].v) best = i;
    return { index: best, i0, i1, max: profile[best].v, plateau: true };
  };
  const out: RawPeak[] = [];
  if (f0 - p.i0 >= 4) out.push(make(p.i0, Math.min(f0 + 1, p.i1)));
  out.push(make(Math.max(f0, f1 - 1), f1));
  if (p.i1 - f1 >= 4) out.push(make(Math.max(f1 - 1, p.i0), p.i1));
  return out;
}

/**
 * 条带检测：
 * - 局部极大值 + 显著性
 * - 重叠：两峰之间的谷底超过阈值则视为两条重叠带，均保留为候选
 * - 饱和：触及满量程；拖尾：下行质心偏移
 */
export function detectBands(
  img: RawImage,
  lane: DetectedLane,
  budget: Budget,
  fullScale: number,
  saturationFraction: number,
  paramOverrides?: Record<string, number | string>
): DetectedBand[] {
  checkBudget(budget, img.width * 2);
  const baseParams = { ...DEFAULT_PARAMS[PARAM_VERSIONS.bandDetection].values, ...(paramOverrides ?? {}) };
  const minProm = baseParams.minProminence as number;
  const minDist = baseParams.minPeakDistancePx as number;
  const valleyRatio = baseParams.overlapValleyRatio as number;
  const broadWidth = baseParams.broadWidthPx as number;
  const tailShift = baseParams.tailingShiftRatio as number;

  const profile = laneProfile(img, lane, 1);
  if (profile.length < 10) {
    throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
      diag('INCOMPLETE_INPUT', 'error', '泳道剖面过短，无法判定条带', { laneId: `lane-${lane.ordinal + 1}` }),
    ]);
  }
  const bg = estimateBackground(profile);

  const rawPeaks: RawPeak[] = [];
  for (let i = 1; i < profile.length - 1; i++) {
    if (profile[i].v <= bg + minProm) continue;
    if (profile[i].v >= profile[i - 1].v && profile[i].v >= profile[i + 1].v) {
      let i0 = i;
      while (i0 > 0 && profile[i0 - 1].v < profile[i0].v) i0--;
      let i1 = i;
      while (i1 < profile.length - 1 && profile[i1 + 1].v < profile[i1].v) i1++;
      const plateau = profile[i].v >= profile[i - 1].v && profile[i].v === profile[i + 1].v;
      rawPeaks.push({ index: i, i0, i1, max: profile[i].v, plateau });
    }
  }

  // 重叠拆分：寻找宽包络内的次峰与浅谷
  const peaks: RawPeak[] = [];
  for (const p of rawPeaks) {
    const satLevel = fullScale * saturationFraction;
    if (profile[p.index].v >= satLevel) {
      peaks.push(...splitSaturatedPlateau(profile, p));
      continue;
    }
    // 在 [i0,i1] 内寻找满足浅谷条件的次局部峰
    const subs: RawPeak[] = [];
    for (let i = p.i0 + minDist; i < p.i1 - minDist; i++) {
      if (
        profile[i].v > bg + minProm &&
        profile[i].v >= profile[i - 1].v &&
        profile[i].v >= profile[i + 1].v
      ) {
        subs.push({ index: i, i0: p.i0, i1: p.i1, max: profile[i].v, plateau: false });
      }
    }
    const all = [p, ...subs].sort((a, b) => a.index - b.index);
    let split = false;
    for (let k = 0; k < all.length - 1; k++) {
      const a = all[k];
      const b = all[k + 1];
      let valley = Infinity;
      for (let i = a.index; i <= b.index; i++) valley = Math.min(valley, profile[i].v);
      if (
        b.index - a.index >= minDist &&
        valley < Math.min(a.max, b.max) * valleyRatio &&
        valley > bg + minProm * 0.4
      ) {
        split = true;
      }
    }
    if (split) peaks.push(...all);
    else peaks.push(p);
  }

  // 最小峰间距（NMS）
  peaks.sort((a, b) => b.max - a.max);
  const kept: RawPeak[] = [];
  for (const p of peaks) {
    if (kept.every((q) => Math.abs(profile[p.index].t - profile[q.index].t) >= minDist)) kept.push(p);
  }
  kept.sort((a, b) => a.index - b.index);

  const out: DetectedBand[] = [];
  for (let pi = 0; pi < kept.length; pi++) {
    const p = kept[pi];
    const diagnostics: Diagnostic[] = [];
    let i0 = p.i0;
    let i1 = p.i1;
    while (i0 > 0 && profile[i0].v > bg + minProm * 0.4) i0--;
    while (i1 < profile.length - 1 && profile[i1].v > bg + minProm * 0.4) i1++;
    const center = profile[p.index];
    let area = 0;
    let weightedT = 0;
    for (let i = i0; i <= i1; i++) {
      const amp = Math.max(0, profile[i].v - bg);
      area += amp;
      weightedT += amp * profile[i].t;
    }
    const centroidT = area > 0 ? weightedT / area : center.t;
    const widthPx = profile[i1].t - profile[i0].t;
    const saturated = center.v >= fullScale * saturationFraction;
    const tailingScore = (centroidT - center.t) / (widthPx || 1);
    const tailing = tailingScore > tailShift;

    if (saturated)
      diagnostics.push(
        diag('SATURATED_BAND', 'warning', `条带在 t=${center.t.toFixed(1)}px 触及满量程，强度上限不可信，仅可作候选`, {
          tArc: center.t,
        })
      );
    if (widthPx >= broadWidth)
      diagnostics.push(
        diag('TAILING_BAND', tailing ? 'warning' : 'info', `条带展宽 ${widthPx.toFixed(1)}px${tailing ? ' 且下行质心偏移，判为拖尾' : ''}`, {
          tArc: center.t,
        })
      );
    if (tailing)
      diagnostics.push(
        diag('TAILING_BAND', 'warning', '拖尾条带：边界不确定，分子量只能给区间', { tArc: center.t })
      );

    const overlaps = kept
      .map((q, qi) => ({ q, qi }))
      .filter(({ q, qi }) => qi !== pi && profile[q.index].t > profile[i0].t && profile[q.index].t < profile[i1].t);
    for (const { q } of overlaps) {
      diagnostics.push(
        diag(
          'OVERLAPPING_BANDS',
          'warning',
          `与 t=${profile[q.index].t.toFixed(1)}px 的条带重叠，保留全部合法候选`,
          { tArc: center.t }
        )
      );
    }

    const at = pointAtArcLength(lane.poly, lane.table, centroidT);
    out.push({
      laneOrdinal: lane.ordinal,
      tArcPx: centroidT,
      x: at.point.x,
      y: at.point.y,
      peak: center.v,
      background: bg,
      area,
      widthPx,
      saturated,
      tailing,
      tailingScore,
      diagnostics,
    });
  }
  return out;
}
