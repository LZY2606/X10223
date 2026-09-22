import { Diagnostic, Outcome, failed, ok } from '../../shared/quantity';

export interface LadderPoint {
  bandId: string;
  yPx: number; // datum-corrected image y (see lanes.ts)
  sizeBp: number;
}

export interface ScaleParams {
  version: string;
  maxPoints: number; // resource budget
  minPoints: number;
}

export interface ScaleSegment {
  index: number;
  y0: number;
  y1: number;
  logM0: number;
  logM1: number;
  bandId0: string;
  bandId1: string;
}

export interface ScaleFit {
  segments: ScaleSegment[];
  validity: { yMin: number; yMax: number }; // local ruler valid region, corrected-y px
  residuals: { bandId: string; yPx: number; residual: number }[]; // vs global log-linear trend
  slope: number;
  intercept: number;
  usedBandIds: string[];
}

export type MwEstimate =
  | { type: 'value'; mwBp: number; logMw: number; segment: ScaleSegment }
  | { type: 'interval'; note: 'OUTSIDE_VALIDITY_REGION'; side: 'above' | 'below'; nearestBoundBp: number };

// Fit a local piecewise log-linear ruler. Three failure kinds are distinct:
// FORMAT_CORRUPT (non-finite input), BUDGET_EXHAUSTED (too many points),
// SEMANTIC_UNSOLVABLE (non-monotonic ruler / insufficient points).
export function fitScale(points: LadderPoint[], params: ScaleParams): Outcome<ScaleFit> {
  const diagnostics: Diagnostic[] = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!Number.isFinite(p.yPx) || !Number.isFinite(p.sizeBp) || p.sizeBp <= 0) {
      return failed('FORMAT_CORRUPT', [
        { code: 'BAD_LADDER_POINT', message: `ladder point ${p.bandId} has non-finite or non-positive coordinate`, position: `$.ladderPoints[${i}]`, severity: 'error' },
      ]);
    }
  }
  if (points.length > params.maxPoints) {
    return failed('BUDGET_EXHAUSTED', [
      { code: 'BUDGET_EXHAUSTED', message: `${points.length} ladder points exceed budget maxPoints=${params.maxPoints} (params ${params.version})`, position: '$.ladderPoints', severity: 'error' },
    ]);
  }
  if (points.length < params.minPoints) {
    return failed('SEMANTIC_UNSOLVABLE', [
      { code: 'INSUFFICIENT_POINTS', message: `need at least ${params.minPoints} ladder points, got ${points.length}`, position: '$.ladderPoints', severity: 'error' },
    ]);
  }
  const sorted = [...points].sort((a, b) => a.yPx - b.yPx);
  const inversions: Diagnostic[] = [];
  for (let i = 1; i < sorted.length; i++) {
    if (!(sorted[i].sizeBp < sorted[i - 1].sizeBp)) {
      inversions.push({
        code: 'NON_MONOTONIC_SCALE',
        message: `ruler not monotonic: y=${sorted[i - 1].yPx}px -> ${sorted[i - 1].sizeBp}bp but y=${sorted[i].yPx}px -> ${sorted[i].sizeBp}bp`,
        position: `$.ladderPoints[bandId=${sorted[i].bandId}]`,
        severity: 'error',
      });
    }
  }
  if (inversions.length > 0) return failed('SEMANTIC_UNSOLVABLE', inversions);

  const segments: ScaleSegment[] = [];
  for (let i = 1; i < sorted.length; i++) {
    segments.push({
      index: i - 1,
      y0: sorted[i - 1].yPx,
      y1: sorted[i].yPx,
      logM0: Math.log10(sorted[i - 1].sizeBp),
      logM1: Math.log10(sorted[i].sizeBp),
      bandId0: sorted[i - 1].bandId,
      bandId1: sorted[i].bandId,
    });
  }
  // Global log-linear trend for residual display.
  const n = sorted.length;
  const sx = sorted.reduce((s, p) => s + p.yPx, 0);
  const sy = sorted.reduce((s, p) => s + Math.log10(p.sizeBp), 0);
  const sxx = sorted.reduce((s, p) => s + p.yPx * p.yPx, 0);
  const sxy = sorted.reduce((s, p) => s + p.yPx * Math.log10(p.sizeBp), 0);
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const residuals = sorted.map((p) => ({
    bandId: p.bandId,
    yPx: p.yPx,
    residual: Math.log10(p.sizeBp) - (slope * p.yPx + intercept),
  }));
  return ok(
    {
      segments,
      validity: { yMin: sorted[0].yPx, yMax: sorted[n - 1].yPx },
      residuals,
      slope,
      intercept,
      usedBandIds: sorted.map((p) => p.bandId),
    },
    diagnostics,
  );
}

// Infer molecular weight at a corrected y. Outside the valid region the ruler
// only yields an interval bound, never a fake point value.
export function mwAt(fit: ScaleFit, yPx: number): MwEstimate {
  if (yPx < fit.validity.yMin) {
    const top = fit.segments[0];
    return { type: 'interval', note: 'OUTSIDE_VALIDITY_REGION', side: 'above', nearestBoundBp: Math.pow(10, top.logM0) };
  }
  if (yPx > fit.validity.yMax) {
    const bottom = fit.segments[fit.segments.length - 1];
    return { type: 'interval', note: 'OUTSIDE_VALIDITY_REGION', side: 'below', nearestBoundBp: Math.pow(10, bottom.logM1) };
  }
  for (const seg of fit.segments) {
    if (yPx >= seg.y0 && yPx <= seg.y1) {
      const t = seg.y1 === seg.y0 ? 0 : (yPx - seg.y0) / (seg.y1 - seg.y0);
      const logMw = seg.logM0 + t * (seg.logM1 - seg.logM0);
      return { type: 'value', mwBp: Math.pow(10, logMw), logMw, segment: seg };
    }
  }
  const bottom = fit.segments[fit.segments.length - 1];
  return { type: 'interval', note: 'OUTSIDE_VALIDITY_REGION', side: 'below', nearestBoundBp: Math.pow(10, bottom.logM1) };
}
