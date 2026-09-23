import { projectToPolyline, arcLengths, type Projection } from './geometry';
import type { PixelPoint } from './types';
import type { ComputeBudget } from './types';
import { GelBenchError } from './types';

/**
 * 自动检测层。注意：检测结果只是候选材料（origin=auto），
 * 人工修订产生新材料版本；计算层负责把证据保留为轮廓。
 */

export interface DetectedLane {
  laneIndex: number;
  x: number;
  left: number;
  right: number;
  width: number;
}

export interface DetectedBand {
  x: number;
  y: number;
  t: number;
  peak: number;
  saturated: boolean;
  smeared: boolean;
  fwhmPx: number;
  profile: { t: number; v: number }[];
}

export interface AnalysisParams {
  saturationThreshold: number | null;
  minPeakDistancePx: number | null;
  saturationLevel: number | null;
}

function checkBudget(w: number, h: number, budget: ComputeBudget): void {
  if (w * h > budget.maxPixels) {
    throw new GelBenchError('budget-exhausted', `图像像素数 ${w * h} 超过预算 ${budget.maxPixels}`, [
      { code: 'BUDGET_EXHAUSTED', message: `maxPixels=${budget.maxPixels}`, location: { kind: 'parameter', name: 'maxPixels' } }
    ]);
  }
}

/** 泳道检测：列方向暗度累计，找连续暗柱区域 */
export function detectLanes(gray: Uint8Array, w: number, h: number, budget: ComputeBudget): DetectedLane[] {
  checkBudget(w, h, budget);
  const colDark = new Float64Array(w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) colDark[x] += 255 - gray[y * w + x];
  }
  const maxDark = Math.max(1, ...colDark);
  const norm = Float64Array.from(colDark, (v) => v / maxDark);
  const thresh = 0.18;
  const runs: { l: number; r: number }[] = [];
  let start = -1;
  for (let x = 0; x < w; x++) {
    const on = norm[x] > thresh;
    if (on && start < 0) start = x;
    if ((!on || x === w - 1) && start >= 0) {
      const end = on ? x : x - 1;
      runs.push({ l: start, r: end });
      start = -1;
    }
  }
  const merged = mergeRuns(runs, 6).filter((r) => r.r - r.l >= 8);
  return merged.map((r, i) => ({
    laneIndex: i,
    x: (r.l + r.r) / 2,
    left: r.l,
    right: r.r,
    width: r.r - r.l + 1
  }));
}

function mergeRuns(runs: { l: number; r: number }[], gap: number): { l: number; r: number }[] {
  const out: { l: number; r: number }[] = [];
  for (const run of runs) {
    const last = out[out.length - 1];
    if (last && run.l - last.r <= gap) last.r = run.r;
    else out.push({ ...run });
  }
  return out;
}

/** 沿泳道中心曲线取暗度轮廓（在曲线法向 ±halfWidth 内取平均） */
export function laneProfile(
  gray: Uint8Array,
  w: number,
  h: number,
  center: PixelPoint[],
  halfWidth: number,
  sampleStep = 1,
  budget: ComputeBudget = { maxPixels: 2e6, maxOps: 5e7 }
): { t: number; v: number }[] {
  const lens = arcLengths(center);
  const total = lens[lens.length - 1];
  const profile: { t: number; v: number }[] = [];
  let ops = 0;
  for (let s = 0; s <= Math.floor(total); s += sampleStep) {
    const { point, seg } = pointAtArc(center, lens, s);
    const segLen = Math.hypot(center[seg + 1].x - center[seg].x, center[seg + 1].y - center[seg].y) || 1;
    const tx = (center[seg + 1].x - center[seg].x) / segLen;
    const ty = (center[seg + 1].y - center[seg].y) / segLen;
    let sum = 0;
    let n = 0;
    for (let off = -halfWidth; off <= halfWidth; off += 2) {
      const px = Math.round(point.x - ty * off);
      const py = Math.round(point.y + tx * off);
      if (px >= 0 && px < w && py >= 0 && py < h) {
        sum += 255 - gray[py * w + px];
        n++;
        ops++;
      }
    }
    if (ops > budget.maxOps) {
      throw new GelBenchError('budget-exhausted', `轮廓采样操作数超过预算 ${budget.maxOps}`, [
        { code: 'BUDGET_EXHAUSTED', message: `maxOps=${budget.maxOps}`, location: { kind: 'parameter', name: 'maxOps' } }
      ]);
    }
    profile.push({ t: s, v: n ? sum / n / 255 : 0 });
  }
  return profile;
}

function pointAtArc(points: PixelPoint[], lens: number[], t: number): { point: { x: number; y: number }; seg: number } {
  for (let i = 0; i < points.length - 1; i++) {
    if (t <= lens[i + 1] || i === points.length - 2) {
      const segLen = lens[i + 1] - lens[i] || 1;
      const f = Math.max(0, Math.min(1, (t - lens[i]) / segLen));
      return {
        point: { x: points[i].x + f * (points[i + 1].x - points[i].x), y: points[i].y + f * (points[i + 1].y - points[i].y) },
        seg: i
      };
    }
  }
  return { point: { ...points[points.length - 1] }, seg: points.length - 2 };
}

/** 在轮廓上找暗峰（条带）。重叠的双峰若可分则返回两个，并打 overlap 标 */
export function detectBands(
  profile: { t: number; v: number }[],
  center: PixelPoint[],
  params: AnalysisParams,
  budget: ComputeBudget
): DetectedBand[] {
  if (profile.length < 5) return [];
  const minDist = params.minPeakDistancePx ?? 10;
  const values = profile.map((p) => p.v);
  const baseline = estimateBaseline(values);
  const signal = values.map((v) => Math.max(0, v - baseline));
  const maxV = Math.max(...signal, 1e-6);
  const norm = signal.map((v) => v / maxV);

  const candidates: { idx: number; prom: number }[] = [];
  for (let i = 2; i < norm.length - 2; i++) {
    if (norm[i] > 0.12 && norm[i] >= norm[i - 1] && norm[i] >= norm[i + 1] && norm[i] > norm[i - 2] && norm[i] > norm[i + 2]) {
      candidates.push({ idx: i, prom: norm[i] });
    }
  }
  candidates.sort((a, b) => b.prom - a.prom);
  const picked: { idx: number; prom: number }[] = [];
  for (const c of candidates) {
    if (picked.every((p) => Math.abs(profile[c.idx].t - profile[p.idx].t) >= minDist * 0.6)) picked.push(c);
  }
  picked.sort((a, b) => profile[a.idx].t - profile[b.idx].t);

  const satThresh = params.saturationThreshold ?? 0.95;
  const out: DetectedBand[] = [];
  const segInfo = new Map<number, { halfL: number; halfR: number }>();
  for (const c of picked) {
    const half = halfWidths(norm, c.idx, 0.5);
    segInfo.set(c.idx, half);
  }
  picked.forEach((c, k) => {
    const { t } = profile[c.idx];
    const { point } = pointAtArc(center, arcLengths(center), t);
    const half = segInfo.get(c.idx)!;
    const fwhm = (half.halfL + half.halfR) * (profile[1] ? profile[1].t - profile[0].t : 1);
    const peak = norm[c.idx];
    const saturated = params.saturationLevel !== null && peak >= satThresh && isPlateau(values, c.idx, baseline, maxV);
    const asymmetry = Math.abs(half.halfR - half.halfL) / Math.max(1, half.halfL + half.halfR);
    const broad = fwhm > minDist * 1.8;
    const closeNext = picked[k + 1] && profile[picked[k + 1].idx].t - t < minDist * 1.6;
    const closePrev = picked[k - 1] && t - profile[picked[k - 1].idx].t < minDist * 1.6;
    const valleyShallow = closeNext
      ? valleyBetween(norm, c.idx, picked[k + 1].idx) > 0.55 * Math.min(norm[c.idx], norm[picked[k + 1].idx])
      : false;
    const smeared = asymmetry > 0.28 || broad;
    const overlap = Boolean(closeNext && valleyShallow);
    const band: DetectedBand = {
      x: point.x,
      y: point.y,
      t,
      peak,
      saturated,
      smeared: smeared || Boolean(closeNext && valleyShallow),
      fwhmPx: fwhm,
      profile: profile.map((p) => ({ t: p.t, v: p.v }))
    };
    void overlap;
    void closePrev;
    out.push(band);
    if (band.profile.length > budget.maxOps) {
      throw new GelBenchError('budget-exhausted', '轮廓点数超过预算', [
        { code: 'BUDGET_EXHAUSTED', message: 'profile too large', location: null }
      ]);
    }
  });
  return out;
}

function valleyBetween(norm: number[], i: number, j: number): number {
  let m = Infinity;
  for (let k = i; k <= j; k++) m = Math.min(m, norm[k]);
  return m;
}

function isPlateau(values: number[], idx: number, baseline: number, maxV: number): boolean {
  const level = baseline + maxV;
  const v = values[idx];
  return level - v < 0.02 * level;
}

function halfWidths(norm: number[], idx: number, level: number): { halfL: number; halfR: number } {
  const target = norm[idx] * level;
  let l = idx;
  while (l > 0 && norm[l] > target) l--;
  let r = idx;
  while (r < norm.length - 1 && norm[r] > target) r++;
  return { halfL: idx - l, halfR: r - idx };
}

function estimateBaseline(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.15)] ?? 0;
}

/** 把像素点投影到泳道（复核层用来计算偏移） */
export function projectBand(center: PixelPoint[], x: number, y: number): Projection {
  return projectToPolyline({ x, y }, center);
}
