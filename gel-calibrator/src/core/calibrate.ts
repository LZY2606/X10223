// Calibration math. Pure functions, directly testable, no I/O.
import {
  BandInference, CalibrationParams, CalibrationSegment, CalibrationStatus,
  Diagnostic, InferenceVerdict, LadderMaterial, LadderPoint, Quantity,
  budgetExhausted, incomplete, unsolvable,
} from './types.js';
import { canonicalJSON, sha256Hex, valueId } from './ids.js';

export interface BandInput {
  bandRef: string;
  bandKey: string;
  laneId: string;
  centerPx: { x: number; y: number };   // raw frame
  migrationPx: number;                  // canonical migration distance (px)
  ladderIndex?: number;                 // declared nominal index for ladder bands
  saturated?: boolean;
  smeared?: boolean;
  overlapGroup?: string;
}

/** Rotate a raw pixel into the canonical frame (migration runs +y). */
export function toCanonical(
  p: { x: number; y: number },
  orientation: 0 | 90 | 180 | 270,
  width: number,
  height: number,
): { x: number; y: number } {
  switch (orientation) {
    case 0: return { x: p.x, y: p.y };
    case 90: return { x: height - 1 - p.y, y: p.x };
    case 180: return { x: width - 1 - p.x, y: height - 1 - p.y };
    case 270: return { x: p.y, y: width - 1 - p.x };
  }
}

export function canonicalDims(orientation: 0 | 90 | 180 | 270, w: number, h: number) {
  return orientation % 180 === 0 ? { width: w, height: h } : { width: h, height: w };
}

/** Migration distance of a canonical point: y minus the well (topmost ladder point). */
export function migrationOf(canonY: number, wellY: number): number {
  return canonY - wellY;
}

function log10q(v: number): number { return Math.log10(v); }

/**
 * Build ladder points from a ladder material + matched band centers.
 * Missing ladder bands (nominal without a band) are recorded; interpolation
 * may bridge the gap but the segment is flagged.
 */
export function buildLadderPoints(
  ladder: LadderMaterial,
  matchedBands: BandInput[],   // may carry ladderIndex; otherwise arc-ordered
  missingIndexes: number[],    // nominal indexes with no detected band
): { points: LadderPoint[]; missing: number[] } {
  if (!ladder.nominals.length) throw incomplete('ladder.nominals', 'ladder has no nominal sizes');
  const points: LadderPoint[] = [];
  const indexed = matchedBands.some((b) => b.ladderIndex !== undefined);
  for (let i = 0; i < ladder.nominals.length; i++) {
    if (missingIndexes.includes(i)) continue;
    const band = indexed
      ? matchedBands.find((b) => b.ladderIndex === i)
      : matchedBands[points.length];
    if (!band) throw incomplete(`ladder.match[${i}]`, `no band center matched for nominal index ${i}`);
    const nominal = ladder.nominals[i]!;
    points.push({
      nominal: { value: nominal.value, unit: nominal.unit, frame: nominal.unit },
      migrationPx: { value: band.migrationPx, unit: 'px', frame: 'image_canonical' },
      ladderIndex: i,
      bandRef: band.bandRef,
    });
  }
  return { points, missing: missingIndexes };
}

/**
 * Piecewise log-linear local rulers. Each segment carries an explicit valid
 * region: a "smile" curvature means the same pixel height in different lanes
 * maps to different molecular weights, so every segment is lane-local and
 * range-limited. Non-monotonic rulers are SEMANTIC_UNSOLVABLE, not an error
 * to be papered over.
 */
export function buildCalibration(
  laneId: string,
  points: LadderPoint[],
  missing: number[],
  params: CalibrationParams,
): CalibrationStatus {
  const paramsHash = params.hash ?? 'unversioned';
  if (points.length < params.minLadderPoints) {
    return {
      state: 'failed',
      diagnostic: {
        code: 'INPUT_INCOMPLETE',
        location: `lane[${laneId}].ladderPoints`,
        message: `only ${points.length} ladder points, need >= ${params.minLadderPoints}`,
      },
    };
  }
  // Monotonicity: migration must strictly increase as nominal size decreases.
  for (let i = 1; i < points.length; i++) {
    const prev = points[i - 1]!, cur = points[i]!;
    if (!(cur.migrationPx.value > prev.migrationPx.value)) {
      return {
        state: 'failed',
        diagnostic: {
          code: 'SEMANTIC_UNSOLVABLE',
          location: `lane[${laneId}].ladderPoints[${i}]`,
          message: `non-monotonic ruler: migration ${cur.migrationPx.value}px not > ${prev.migrationPx.value}px`,
        },
      };
    }
    if (!(cur.nominal.value < prev.nominal.value)) {
      return {
        state: 'failed',
        diagnostic: {
          code: 'SEMANTIC_UNSOLVABLE',
          location: `lane[${laneId}].nominals[${i}]`,
          message: `nominal sizes must strictly decrease with migration: ${cur.nominal.value} !< ${prev.nominal.value}`,
        },
      };
    }
  }
  const segments: CalibrationSegment[] = [];
  const diagnostics: Diagnostic[] = [];
  for (let i = 1; i < points.length; i++) {
    const lo = points[i - 1]!, hi = points[i]!;
    const gap = hi.ladderIndex - lo.ladderIndex;
    const bridgedGap = gap > 1;
    if (bridgedGap && gap > params.maxBridgedGap) {
      diagnostics.push({
        code: 'SEMANTIC_UNSOLVABLE',
        location: `lane[${laneId}].segment[${i - 1}]`,
        message: `missing ladder gap of ${gap - 1} band(s) exceeds maxBridgedGap=${params.maxBridgedGap}`,
      });
      continue; // no segment across an unbridgeable gap
    }
    const slope =
      (log10q(hi.nominal.value) - log10q(lo.nominal.value)) /
      (hi.migrationPx.value - lo.migrationPx.value);
    segments.push({
      id: valueId('segment', [laneId, lo.bandRef, hi.bandRef, paramsHash]),
      laneId, lo, hi, slopeLogPerPx: slope,
      validRegion: {
        loPx: lo.migrationPx.value, hiPx: hi.migrationPx.value, frame: 'image_canonical',
      },
      bridgedGap,
    });
    if (bridgedGap) {
      diagnostics.push({
        code: 'INPUT_INCOMPLETE',
        location: `lane[${laneId}].segment[${i - 1}]`,
        message: `segment bridges ${gap - 1} missing ladder band(s); treat as degraded`,
      });
    }
  }
  if (!segments.length) {
    return {
      state: 'failed',
      diagnostic: {
        code: 'SEMANTIC_UNSOLVABLE',
        location: `lane[${laneId}].segments`,
        message: 'no usable calibration segment after gap/monotonicity checks',
      },
    };
  }
  return diagnostics.length
    ? { state: 'degraded', segments, points, diagnostics }
    : { state: 'ok', segments, points };
}

export interface EvalBudget { remaining: number; }
export function makeBudget(params: CalibrationParams): EvalBudget {
  return { remaining: params.evalBudget };
}
function spend(b: EvalBudget, location: string) {
  if (b.remaining <= 0) throw budgetExhausted(location, 'evaluation budget exhausted');
  b.remaining--;
}

/**
 * Infer molecular weight for one band under one lane's calibration.
 * - outside every segment's valid region  -> invalid with location
 * - saturated / smeared                   -> interval only (candidate-grade)
 * - overlapping bands                     -> all legal candidates retained
 */
export function inferBand(
  band: BandInput,
  status: Extract<CalibrationStatus, { state: 'ok' | 'degraded' }>,
  params: CalibrationParams,
  budget: EvalBudget,
): BandInference {
  spend(budget, `band[${band.bandKey}]`);
  const paramsHash = params.hash ?? 'unversioned';
  const m = band.migrationPx;
  const seg = status.segments.find(
    (s) => m >= s.validRegion.loPx && m <= s.validRegion.hiPx,
  );
  const base = {
    bandRef: band.bandRef, bandKey: band.bandKey, laneId: band.laneId,
    centerPx: { ...band.centerPx, frame: 'image_raw' as const },
    migrationPx: { value: m, unit: 'px', frame: 'image_canonical' } as Quantity<'px'>,
    parents: [band.bandRef, ...status.points.map((p) => p.bandRef), paramsHash],
    paramsHash,
  };
  const digestOf = (verdict: InferenceVerdict) =>
    sha256Hex(canonicalJSON({ band: band.bandRef, m, verdict, paramsHash }));

  if (!seg) {
    const nearest = status.segments.reduce((a, b) =>
      Math.min(Math.abs(m - a.validRegion.loPx), Math.abs(m - a.validRegion.hiPx)) <
      Math.min(Math.abs(m - b.validRegion.loPx), Math.abs(m - b.validRegion.hiPx)) ? a : b);
    const verdict: InferenceVerdict = {
      type: 'invalid',
      diagnostic: {
        code: 'SEMANTIC_UNSOLVABLE',
        location: `lane[${band.laneId}].band[${band.bandKey}]`,
        message: `migration ${m}px outside every local ruler valid region ` +
          `[${status.segments.map((s) => `${s.validRegion.loPx}-${s.validRegion.hiPx}`).join(', ')}]px; ` +
          `nearest segment ends at ${m < nearest.validRegion.loPx ? nearest.validRegion.loPx : nearest.validRegion.hiPx}px`,
      },
    };
    return { ...base, id: valueId('inference', [band.bandRef, paramsHash, 'invalid']), verdict, residuals: [], inputDigest: digestOf(verdict) };
  }

  const logMw = log10q(seg.lo.nominal.value) + seg.slopeLogPerPx * (m - seg.lo.migrationPx.value);
  const mw = Math.pow(10, logMw);
  const unit = seg.lo.nominal.unit;
  const residuals = status.points.map((p) => {
    const segOfP = status.segments.find(
      (s) => p.migrationPx.value >= s.validRegion.loPx && p.migrationPx.value <= s.validRegion.hiPx);
    const fit = segOfP
      ? segOfP.slopeLogPerPx * (p.migrationPx.value - segOfP.lo.migrationPx.value) + log10q(segOfP.lo.nominal.value)
      : log10q(p.nominal.value);
    return { ladderPointRef: p.bandRef, residualLog: log10q(p.nominal.value) - fit };
  });

  let verdict: InferenceVerdict;
  if (band.overlapGroup) {
    // Overlapping bands: never a single answer — keep every legal candidate.
    const spread = Math.abs(seg.slopeLogPerPx) * 1.5; // ±1.5px deblend uncertainty
    verdict = {
      type: 'candidates',
      candidates: [
        { value: Math.pow(10, logMw - spread), unit, frame: unit },
        { value: mw, unit, frame: unit },
        { value: Math.pow(10, logMw + spread), unit, frame: unit },
      ],
      reason: `overlap group ${band.overlapGroup}: deblending is not unique`,
    };
  } else if (band.saturated || band.smeared) {
    // Saturated / smeared: interval only, never a point estimate.
    const halfWidthPx = band.saturated ? 2 : 1;
    const dLog = Math.abs(seg.slopeLogPerPx) * halfWidthPx;
    verdict = {
      type: 'interval',
      interval: {
        lo: { value: Math.pow(10, logMw - dLog), unit, frame: unit },
        hi: { value: Math.pow(10, logMw + dLog), unit, frame: unit },
        reason: band.saturated
          ? 'saturated band: centroid biased, interval reported'
          : 'smeared/tailed band: centroid uncertain, interval reported',
      },
      segmentId: seg.id,
    };
  } else {
    verdict = { type: 'value', mw: { value: mw, unit, frame: unit }, segmentId: seg.id };
  }
  return {
    ...base,
    id: valueId('inference', [band.bandRef, paramsHash, seg.id, verdict.type]),
    verdict, residuals, inputDigest: digestOf(verdict),
  };
}

/** Deterministic candidate ordering: equivalent inputs => stable order. */
export function sortInferences(infs: BandInference[]): BandInference[] {
  return [...infs].sort((a, b) =>
    a.laneId.localeCompare(b.laneId) || a.migrationPx.value - b.migrationPx.value || a.id.localeCompare(b.id));
}
