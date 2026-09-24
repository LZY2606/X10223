import { qty, type Qty, diag, type Diagnostic } from './units';
import { fail, ok, type Outcome } from './result';
import { stableId } from './ids';
import { findAnySegment, interpolateBp, type LocalRuler, type RulerSegment } from './ruler';
import type { DetectedBand } from './bands';

export interface EstimateParams {
  version: string;
  method: 'log-linear';
  smileCorrection: boolean;
  maxCandidates: number;
}

export const DEFAULT_ESTIMATE_PARAMS: EstimateParams = {
  version: 'est-v1',
  method: 'log-linear',
  smileCorrection: true,
  maxCandidates: 4,
};

export type EstimateStatus = 'value' | 'interval' | 'candidates' | 'invalid';

export interface MwCandidate {
  valueBp: Qty<'bp'>;
  centerYPx: number;
  basis: string;
}

export interface MwEstimate {
  id: string;
  bandKey: string;
  laneId: string;
  status: EstimateStatus;
  valueBp?: Qty<'bp'>;
  intervalBp?: { lo: Qty<'bp'>; hi: Qty<'bp'> };
  candidates?: MwCandidate[];
  reason?: string;
  segmentId?: string;
  validityRegionPx?: [number, number];
  centerYPx: number;
  unitNote: string;
}

const BP_BASIS = 'local-ruler:log-linear:bp';

function bpQty(value: number): Qty<'bp'> {
  return qty(Math.round(value), 'bp', BP_BASIS);
}

function intervalFromSegment(seg: RulerSegment, yLo: number, yHi: number): { lo: Qty<'bp'>; hi: Qty<'bp'> } {
  const bpHi = interpolateBp(seg, Math.max(seg.yTopPx, yLo));
  const bpLo = interpolateBp(seg, Math.min(seg.yBottomPx, yHi));
  return { lo: bpQty(Math.min(bpLo, bpHi)), hi: bpQty(Math.max(bpLo, bpHi)) };
}

export function estimateBand(
  band: DetectedBand,
  ruler: LocalRuler,
  groupMembers: DetectedBand[],
  params: EstimateParams,
): { estimate: MwEstimate; outcome: Outcome<MwEstimate>; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const y = band.yPx;
  const base: MwEstimate = {
    id: stableId('est', { bandKey: band.bandKey, y, flags: band.flags, segs: ruler.segments.map((s) => s.id) }),
    bandKey: band.bandKey,
    laneId: band.laneId,
    status: 'invalid',
    centerYPx: y,
    unitNote: 'bp via local log-linear ruler; coordinates in gel-norm px',
  };
  const seg = findAnySegment(ruler, y);
  if (!seg) {
    base.reason = 'outside-ruler-range';
    diagnostics.push(
      diag('outside-ruler-range', `band center y=${y.toFixed(1)}px is outside every validity region of the lane local ruler`, 'error', {
        lane: band.laneId,
        band: band.bandKey,
        yPx: y,
      }),
    );
    return { estimate: base, outcome: fail('SemanticUnsolvable', 'band outside any validity region', diagnostics), diagnostics };
  }
  base.segmentId = seg.id;
  base.validityRegionPx = [seg.yTopPx, seg.yBottomPx];
  if (!seg.valid) {
    base.reason = seg.invalidReason ?? 'invalid-segment';
    diagnostics.push(
      diag('invalid-ruler-segment', `interpolation segment ${seg.id} invalid: ${base.reason}`, 'error', {
        lane: band.laneId,
        band: band.bandKey,
        yPx: y,
      }),
    );
    return {
      estimate: base,
      outcome: fail('SemanticUnsolvable', `segment invalid: ${base.reason}`, diagnostics),
      diagnostics,
    };
  }
  if (band.flags.includes('overlap') && groupMembers.length > 1) {
    if (groupMembers.length > params.maxCandidates) {
      base.reason = 'overlap-budget-exceeded';
      return {
        estimate: base,
        outcome: fail(
          'ResourceBudgetExhausted',
          `overlap group has ${groupMembers.length} candidates > budget ${params.maxCandidates}`,
          diagnostics,
        ),
        diagnostics,
      };
    }
    base.status = 'candidates';
    base.reason = 'overlap: multiple legal centers; all candidates retained, none uniquely decidable';
    base.candidates = groupMembers.map((m) => ({
      valueBp: bpQty(interpolateBp(seg, m.yPx)),
      centerYPx: m.yPx,
      basis: `deconvolved-peak@${m.yPx.toFixed(1)}px`,
    }));
    return { estimate: base, outcome: ok(base, diagnostics), diagnostics };
  }
  if (band.flags.includes('saturated')) {
    base.status = 'interval';
    base.reason = 'saturated-band: center may be biased; only an interval is admissible';
    base.intervalBp = intervalFromSegment(seg, y - band.widthPx / 2, y + band.widthPx / 2);
    return { estimate: base, outcome: ok(base, diagnostics), diagnostics };
  }
  if (band.flags.includes('smear')) {
    base.status = 'interval';
    base.reason = 'smear/tailing: asymmetric band; only an interval is admissible';
    base.intervalBp = intervalFromSegment(seg, y - band.upWidthPx, y + band.downWidthPx);
    return { estimate: base, outcome: ok(base, diagnostics), diagnostics };
  }
  base.status = 'value';
  base.valueBp = bpQty(interpolateBp(seg, y));
  return { estimate: base, outcome: ok(base, diagnostics), diagnostics };
}
