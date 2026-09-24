/**
 * Lane intensity profiles and peak detection.
 *
 * Intensity is averaged across the lane strip at every arc-length step, never
 * at image rows, so curved lanes stay aligned. Saturation, tailing and overlap
 * are measured here and propagated as structured statuses downstream.
 */
import type { GrayImage } from './image.js';
import { sampleBilinear } from './image.js';
import type { PixelPoint } from './units.js';
import { pointAtArc } from './geometry.js';
import type {
  BandCenterMaterial,
  Diagnostic,
  ExposureMaterial,
  LaneGeometryResult,
  ParamSet,
  ProfilePeak,
  ProfileResult,
  ProfileSample,
} from './domain.js';
import { digestOf, derivedId } from './identity.js';

const BAND_HALF_ALONG_PX = 2;

export interface ProfileBudget {
  cells: number;
  used: number;
}

function crossSection(
  img: GrayImage,
  geom: LaneGeometryResult,
  s: number,
  saturationCeiling: number,
  budget: ProfileBudget,
): { intensity: number; saturatedFraction: number; at: PixelPoint; exhausted: boolean } {
  const center = pointAtArc(geom.centerline, s);
  const before = pointAtArc(geom.centerline, Math.max(0, s - 1));
  const after = pointAtArc(geom.centerline, Math.min(geom.totalArcLengthPx, s + 1));
  let tx = after.x - before.x;
  let ty = after.y - before.y;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl;
  ty /= tl;
  const nx = -ty;
  const ny = tx;
  const half = Math.max(
    1,
    Math.hypot(
      pointAtArc(geom.right, s).x - pointAtArc(geom.left, s).x,
      pointAtArc(geom.right, s).y - pointAtArc(geom.left, s).y,
    ) /
      2 - 1,
  );
  const steps = Math.max(2, Math.round(half * 2));
  let sum = 0;
  let sat = 0;
  let exhausted = false;
  for (let i = 0; i <= steps; i++) {
    const off = -half + (i / steps) * half * 2;
    const x = center.x + nx * off;
    const y = center.y + ny * off;
    sum += sampleBilinear(img, x, y);
    if (sampleBilinear(img, x, y) >= saturationCeiling) sat++;
    budget.used++;
    if (budget.used > budget.cells) {
      exhausted = true;
      break;
    }
  }
  return {
    intensity: sum / (steps + 1),
    saturatedFraction: sat / (steps + 1),
    at: center,
    exhausted,
  };
}

function smooth(values: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    let acc = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      acc += values[j];
      n++;
    }
    return acc / n;
  });
}

interface RawPeak {
  index: number;
  s: number;
  widthPx: number;
  prominence: number;
  leftBase: number;
  rightBase: number;
  tailFraction: number;
}

function findPeaks(smoothed: number[], sFor: (i: number) => number, minProminence: number): RawPeak[] {
  const peaks: RawPeak[] = [];
  for (let i = 2; i < smoothed.length - 2; i++) {
    if (smoothed[i] <= smoothed[i - 1] || smoothed[i] < smoothed[i + 1]) continue;
    let l = i;
    while (l > 0 && smoothed[l - 1] <= smoothed[l]) l--;
    let r = i;
    while (r < smoothed.length - 1 && smoothed[r + 1] <= smoothed[r]) r++;
    const leftMin = Math.min(...smoothed.slice(l, i + 1));
    const rightMin = Math.min(...smoothed.slice(i, r + 1));
    const base = Math.max(leftMin, rightMin);
    const prominence = smoothed[i] - base;
    if (prominence < minProminence) continue;
    // Half-height width.
    const level = base + prominence / 2;
    let lw = i;
    while (lw > 0 && smoothed[lw] > level) lw--;
    let rw = i;
    while (rw < smoothed.length - 1 && smoothed[rw] > level) rw++;
    let area = 0;
    let tailArea = 0;
    for (let j = lw; j <= rw; j++) {
      const above = Math.max(0, smoothed[j] - base);
      area += above;
      if (j > i) tailArea += above;
    }
    peaks.push({
      index: i,
      s: sFor(i),
      widthPx: sFor(rw) - sFor(lw),
      prominence,
      leftBase: l,
      rightBase: r,
      tailFraction: area === 0 ? 0 : tailArea / area,
    });
  }
  return peaks;
}

function footprintPolygon(
  geom: LaneGeometryResult,
  s: number,
  halfWidthAlong: number,
  marginPx = 1,
): PixelPoint[] {
  const half =
    Math.hypot(
      pointAtArc(geom.right, s).x - pointAtArc(geom.left, s).x,
      pointAtArc(geom.right, s).y - pointAtArc(geom.left, s).y,
    ) / 2 - marginPx;
  const mk = (along: number, side: number): PixelPoint => {
    const c = pointAtArc(geom.centerline, Math.max(0, Math.min(geom.totalArcLengthPx, s + along)));
    const b = pointAtArc(geom.centerline, Math.max(0, Math.min(geom.totalArcLengthPx, s + along + 1)));
    const a = pointAtArc(geom.centerline, Math.max(0, Math.min(geom.totalArcLengthPx, s + along - 1)));
    let tx = b.x - a.x;
    let ty = b.y - a.y;
    const tl = Math.hypot(tx, ty) || 1;
    const nx = -ty / tl;
    const ny = tx / tl;
    return {
      x: c.x + nx * half * side,
      y: c.y + ny * half * side,
      frame: c.frame,
      imageSeq: c.imageSeq,
      source: 'footprint',
    };
  };
  return [mk(-halfWidthAlong, -1), mk(-halfWidthAlong, 1), mk(halfWidthAlong, 1), mk(halfWidthAlong, -1)];
}

export interface BuildProfileInput {
  img: GrayImage;
  geom: LaneGeometryResult;
  params: ParamSet;
  exposure: ExposureMaterial;
  bandCenters: BandCenterMaterial[];
  stepPx?: number;
  cellBudget?: number;
}

export function buildProfile(input: BuildProfileInput): {
  result: ProfileResult | null;
  diagnostics: Diagnostic[];
  outcome: 'ok' | 'budget_exhausted';
  budgetUsed: number;
} {
  const { img, geom, params, exposure } = input;
  const step = input.stepPx ?? 1;
  const budget: ProfileBudget = { cells: input.cellBudget ?? Number.POSITIVE_INFINITY, used: 0 };
  const samples: ProfileSample[] = [];
  let exhausted = false;
  for (let s = 0; s <= geom.totalArcLengthPx; s += step) {
    const cs = crossSection(img, geom, s, exposure.saturationCeiling, budget);
    samples.push({ s, intensity: cs.intensity, saturatedFraction: cs.saturatedFraction, at: cs.at });
    if (cs.exhausted) {
      exhausted = true;
      break;
    }
  }
  if (exhausted) {
    return {
      result: null,
      diagnostics: [
        {
          code: 'BUDGET_EXHAUSTED',
          message: `Pixel budget ${budget.cells} exhausted while sampling lane ${geom.laneId}.`,
          severity: 'error',
          subject: { kind: 'lane', id: geom.laneId },
        },
      ],
      outcome: 'budget_exhausted',
      budgetUsed: budget.used,
    };
  }
  const raw = samples.map((s2) => s2.intensity);
  const smoothed = smooth(raw, params.profileSmoothPx);
  const minProm = params.minProminenceFraction * (Math.max(...smoothed) - Math.min(...smoothed) || 1);
  const raws = findPeaks(smoothed, (i) => samples[i]?.s ?? 0, minProm);

  // Pin peaks to declared band-center materials within a 3px arc tolerance.
  const peaks: ProfilePeak[] = raws.map((rp, k) => {
    const near = input.bandCenters
      .filter((bc) => bc.laneId === geom.laneId)
      .map((bc) => {
        const sBc = nearestArcForPixel(geom, bc.center.x, bc.center.y);
        return { bc, sBc, d: Math.abs(sBc - rp.s) };
      })
      .filter((m) => m.d <= 3)
      .sort((a, b) => a.d - b.d)[0];
    const sUse = near ? near.sBc : rp.s;
    const sat = saturatedAround(samples, sUse);
    return {
      bandId: near ? near.bc.id : `peak_${geom.laneId}_${k}`,
      sPx: sUse,
      widthPx: rp.widthPx,
      prominence: rp.prominence,
      saturatedFraction: sat,
      tailFraction: rp.tailFraction,
      footprint: footprintPolygon(geom, sUse, BAND_HALF_ALONG_PX),
      center: pointAtArc(geom.centerline, sUse),
      overlapWith: [],
      sourceBandCenterId: near?.bc.id,
      origin: near ? near.bc.origin : 'auto',
    };
  });

  const diagnostics: Diagnostic[] = [];
  // Overlap: footprint intervals along arc.
  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < peaks.length; j++) {
      const a = peaks[i];
      const b = peaks[j];
      const aLo = a.sPx - a.widthPx / 2;
      const aHi = a.sPx + a.widthPx / 2;
      const bLo = b.sPx - b.widthPx / 2;
      const bHi = b.sPx + b.widthPx / 2;
      const inter = Math.max(0, Math.min(aHi, bHi) - Math.max(aLo, bLo));
      const smaller = Math.min(aHi - aLo, bHi - bLo) || 1;
      if (inter / smaller >= params.overlapFractionThreshold) {
        a.overlapWith.push(b.bandId);
        b.overlapWith.push(a.bandId);
      }
    }
  }
  for (const p of peaks) {
    if (p.saturatedFraction >= params.saturationFractionThreshold) {
      diagnostics.push({
        code: 'SATURATED_BAND',
        message: `Band ${p.bandId} has saturated pixels (${(p.saturatedFraction * 100).toFixed(1)}%); only an interval is legal.`,
        severity: 'warning',
        subject: { kind: 'band', id: p.bandId },
        at: { x: p.center.x, y: p.center.y, frame: p.center.frame },
      });
    }
    if (p.overlapWith.length > 0) {
      diagnostics.push({
        code: 'OVERLAPPING_BANDS',
        message: `Band ${p.bandId} overlaps ${p.overlapWith.join(', ')}; keep all legal candidates.`,
        severity: 'warning',
        subject: { kind: 'band', id: p.bandId },
        at: { x: p.center.x, y: p.center.y, frame: p.center.frame },
      });
    }
    if (p.tailFraction >= 0.62 && p.widthPx >= 4) {
      diagnostics.push({
        code: 'SMEAR_TAIL',
        message: `Band ${p.bandId} shows a migration-direction tail; treat as candidate/interval.`,
        severity: 'warning',
        subject: { kind: 'band', id: p.bandId },
      });
    }
  }

  const inputDigest = digestOf({
    geom: geom.id,
    exposure: exposure.id,
    bandCenters: input.bandCenters.map((b) => b.id),
    params,
  });
  const result: ProfileResult = {
    id: derivedId('profile', inputDigest, geom.laneId),
    laneId: geom.laneId,
    geometryId: geom.id,
    samples,
    peaks,
    inputDigest,
    paramsVersion: params.version,
    parents: [geom.id, exposure.id, ...input.bandCenters.map((b) => b.id)],
  };
  return { result, diagnostics, outcome: 'ok', budgetUsed: budget.used };
}

function saturatedAround(samples: ProfileSample[], s: number): number {
  const near = samples.filter((q) => Math.abs(q.s - s) <= BAND_HALF_ALONG_PX);
  if (near.length === 0) return 0;
  return near.reduce((a, q) => a + q.saturatedFraction, 0) / near.length;
}

/** Nearest arc position for an arbitrary pixel point (used by pinning/review). */
export function nearestArcForPixel(geom: LaneGeometryResult, x: number, y: number): number {
  let bestS = 0;
  let bestD = Number.POSITIVE_INFINITY;
  for (const s of geom.arcLengthsPx) {
    const p = pointAtArc(geom.centerline, s);
    const d = (p.x - x) ** 2 + (p.y - y) ** 2;
    if (d < bestD) {
      bestD = d;
      bestS = s;
    }
  }
  return bestS;
}
