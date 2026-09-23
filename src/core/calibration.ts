import type {
  BandObservation,
  CalibrationSegment,
  Diagnostic,
  LadderRung,
  LaneGeometry,
  LocalRuler,
  MolecularWeightResult,
} from '../shared/model.js';
import { migrationS } from './geometry.js';

export interface CalibrationParameters {
  extrapolationBudgetMm: number;
  pxPerMm: number;
  saturationThreshold: number;
  tailingAsymmetry: number;
  overlapSeparationPx: number;
}

export const DEFAULT_CALIBRATION_PARAMETERS: CalibrationParameters = {
  extrapolationBudgetMm: 1.0,
  pxPerMm: 10,
  saturationThreshold: 8,
  tailingAsymmetry: 1.8,
  overlapSeparationPx: 14,
};

export interface RungPosition {
  rung: LadderRung;
  s: number;
  bp: number;
}

export function orderedRungPositions(
  rungs: LadderRung[],
  ladderLane: LaneGeometry,
  bands: BandObservation[],
): { positions: RungPosition[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const byId = new Map(bands.map((b) => [b.bandId, b]));
  const positions: RungPosition[] = [];
  for (const rung of rungs) {
    if (!rung.observed || !rung.bandId) continue;
    if (rung.nominalBp.value === null) {
      diagnostics.push({
        code: 'LADDER-NOMINAL-UNPARSEABLE',
        severity: 'error',
        message: `Ladder 标称值 "${rung.nominalBp.raw ?? ''}" 无法转换，保留原始表示，未用于校准`,
        rungId: rung.rungId,
        path: `ladder.rungs[${rung.rungId}].nominalBp`,
      });
      continue;
    }
    const band = byId.get(rung.bandId);
    if (!band) {
      diagnostics.push({
        code: 'LADDER-BAND-MISSING',
        severity: 'warning',
        message: `Rung ${rung.rungId} 引用的条带不存在`,
        rungId: rung.rungId,
      });
      continue;
    }
    positions.push({ rung, s: migrationS(ladderLane, band.center).s, bp: rung.nominalBp.value });
  }
  positions.sort((a, b) => a.s - b.s);
  return { positions, diagnostics };
}

export function buildLocalRuler(
  ladderLane: LaneGeometry,
  rungs: LadderRung[],
  bands: BandObservation[],
  params: CalibrationParameters,
): LocalRuler {
  const { positions, diagnostics } = orderedRungPositions(rungs, ladderLane, bands);
  const observedCount = rungs.filter((r) => r.observed && r.bandId).length;
  if (observedCount < positions.length) {
    const observed = new Set(positions.map((p) => p.rung.rungId));
    for (const rung of rungs) {
      if (rung.observed && rung.bandId && !observed.has(rung.rungId)) continue;
    }
  }
  for (const rung of rungs) {
    if (!rung.observed || !rung.bandId) {
      diagnostics.push({
        code: 'LADDER-RUNG-MISSING',
        severity: 'warning',
        message: `Ladder 缺带：${rung.rungId} 标称 ${rung.nominalBp.raw ?? rung.nominalBp.value ?? '?'} bp 未被观察到，该区间插值段不可用`,
        rungId: rung.rungId,
      });
    }
  }

  const segments: CalibrationSegment[] = [];
  const nonMonotonicRungs = new Set<string>();
  for (let i = 1; i < positions.length; i++) {
    const a = positions[i - 1]!;
    const b = positions[i]!;
    const expected = bpDecreasesWithMigration(a.bp, b.bp);
    const slope = (Math.log(b.bp) - Math.log(a.bp)) / (b.s - a.s);
    if (!expected || b.s <= a.s || !Number.isFinite(slope)) {
      nonMonotonicRungs.add(a.rung.rungId);
      nonMonotonicRungs.add(b.rung.rungId);
      segments.push({
        rungA: a.rung.rungId,
        rungB: b.rung.rungId,
        sA: a.s,
        sB: b.s,
        bpA: a.bp,
        bpB: b.bp,
        slope,
        intercept: 0,
        valid: false,
        reason: '非单调标尺：相邻 ladder 点不满足迁移越大分子量越小',
      });
      diagnostics.push({
        code: 'RULER-NON-MONOTONIC',
        severity: 'error',
        message: `非单调标尺：${a.rung.rungId}(${a.bp}bp) 与 ${b.rung.rungId}(${b.bp}bp) 之间不能构成合法插值段`,
        rungId: b.rung.rungId,
        laneId: ladderLane.laneId,
        validRegion: { axis: 's', from: a.s, to: b.s, unit: 'px' },
      });
      continue;
    }
    const intercept = Math.log(a.bp) - slope * a.s;
    segments.push({
      rungA: a.rung.rungId,
      rungB: b.rung.rungId,
      sA: a.s,
      sB: b.s,
      bpA: a.bp,
      bpB: b.bp,
      slope,
      intercept,
      valid: true,
    });
  }

  const validSegments = segments.filter((seg) => seg.valid);
  const validRegion = validSegments.length
    ? {
        fromS: Math.min(...validSegments.map((seg) => seg.sA)),
        toS: Math.max(...validSegments.map((seg) => seg.sB)),
        unit: 'px-migration-arc',
      }
    : { fromS: NaN, toS: NaN, unit: 'px-migration-arc' };

  const budgetPx = params.extrapolationBudgetMm * params.pxPerMm;
  return {
    laneId: ladderLane.laneId,
    segments,
    validRegion,
    extrapolationBudget: { before: budgetPx, after: budgetPx, unit: 'px-arc (=mm*pxPerMm)' },
    diagnostics,
  };
}

function bpDecreasesWithMigration(nearBp: number, farBp: number): boolean {
  return farBp < nearBp;
}

export function inferMolecularWeight(
  band: BandObservation,
  lane: LaneGeometry,
  ruler: LocalRuler,
  params: CalibrationParameters,
  allBands: BandObservation[],
  derivationId: string,
): MolecularWeightResult {
  const { s } = migrationS(lane, band.center);
  const diagnostics: Diagnostic[] = [...ruler.diagnostics.filter((d) => d.severity === 'error')];
  const validSegments = ruler.segments.filter((seg) => seg.valid);
  const region = ruler.validRegion;
  const budget = ruler.extrapolationBudget;

  if (!validSegments.length || Number.isNaN(region.fromS)) {
    return {
      bandId: band.bandId,
      laneId: lane.laneId,
      s,
      status: 'impossible',
      bp: null,
      validRegion: { fromS: region.fromS, toS: region.toS },
      diagnostics: [
        ...diagnostics,
        {
          code: 'MW-NO-VALID-RULER',
          severity: 'error',
          message: '标尺不存在任何单调插值段，无法唯一决定分子量',
          bandId: band.bandId,
          laneId: lane.laneId,
        },
      ],
      derivationId,
    };
  }

  const enclosing = validSegments.find((seg) => s >= seg.sA && s <= seg.sB);
  if (!enclosing) {
    const withinBudget =
      (s < region.fromS && region.fromS - s <= budget.before) ||
      (s > region.toS && s - region.toS <= budget.after);
    const nearest = nearestSegment(validSegments, s);
    diagnostics.push({
      code: withinBudget ? 'MW-EXTRAPOLATED' : 'MW-OUTSIDE-VALID-REGION',
      severity: withinBudget ? 'warning' : 'error',
      message: withinBudget
        ? '条带位于标尺有效区之外但在允许外推预算内，结果仅作候选'
        : '条带超出局部标尺有效区与外推预算，拒绝给出数值',
      bandId: band.bandId,
      laneId: lane.laneId,
      validRegion: { axis: 's', from: region.fromS, to: region.toS, unit: 'px' },
    });
    const bp = Math.exp(nearest.slope * s + nearest.intercept);
    const result: MolecularWeightResult = {
      bandId: band.bandId,
      laneId: lane.laneId,
      s,
      status: withinBudget ? 'candidate-set' : 'outside-ruler',
      bp: withinBudget ? bp : null,
      candidatesBp: withinBudget ? [bp] : undefined,
      segmentRef: { fromRung: nearest.rungA, toRung: nearest.rungB, laneId: ruler.laneId },
      validRegion: { fromS: region.fromS, toS: region.toS },
      diagnostics,
      derivationId,
    };
    return result;
  }

  const candidates: number[] = [];
  const clean = band.exposure === 'ok' && band.tailing === 'none' && !(band.overlapWith?.length);
  const uncertaintySigma = band.fit.sigma;

  if (band.exposure === 'saturated') {
    diagnostics.push({
      code: 'MW-SATURATED-BAND',
      severity: 'warning',
      message: '饱和条带：峰顶被削平，中心位置不可靠，只能给出区间',
      bandId: band.bandId,
      laneId: lane.laneId,
    });
    const low = Math.exp(enclosing.slope * (s + uncertaintySigma) + enclosing.intercept);
    const high = Math.exp(enclosing.slope * (s - uncertaintySigma) + enclosing.intercept);
    return {
      bandId: band.bandId,
      laneId: lane.laneId,
      s,
      status: 'interval',
      bp: null,
      intervalBp: { low: Math.min(low, high), high: Math.max(low, high) },
      segmentRef: { fromRung: enclosing.rungA, toRung: enclosing.rungB, laneId: ruler.laneId },
      validRegion: { fromS: region.fromS, toS: region.toS },
      diagnostics,
      derivationId,
    };
  }

  if (band.overlapWith?.length) {
    const partners = band.overlapWith
      .map((id) => allBands.find((b) => b.bandId === id))
      .filter((b): b is BandObservation => Boolean(b) && b!.laneId === lane.laneId);
    const alternativeCenters = [s, ...partners.map((p) => migrationS(lane, p.center).s)];
    for (const altS of alternativeCenters) {
      candidates.push(Math.exp(enclosing.slope * altS + enclosing.intercept));
    }
    diagnostics.push({
      code: 'MW-OVERLAPPING-BANDS',
      severity: 'warning',
      message: `两条带重叠（${[band.bandId, ...band.overlapWith].join('、')}），无法唯一决定，保留全部合法候选`,
      bandId: band.bandId,
      laneId: lane.laneId,
    });
    return finalizeCandidates(candidates, s, enclosing, region, diagnostics, derivationId, band, lane);
  }

  if (band.tailing !== 'none') {
    const shift = uncertaintySigma * 0.6;
    candidates.push(Math.exp(enclosing.slope * (s - shift) + enclosing.intercept));
    candidates.push(Math.exp(enclosing.slope * s + enclosing.intercept));
    diagnostics.push({
      code: 'MW-TAILING-BAND',
      severity: 'warning',
      message: `拖尾条带（${band.tailing}）：质心偏移，标为候选集`,
      bandId: band.bandId,
      laneId: lane.laneId,
    });
    return finalizeCandidates(candidates, s, enclosing, region, diagnostics, derivationId, band, lane);
  }

  if (clean) {
    const bp = Math.exp(enclosing.slope * s + enclosing.intercept);
    return {
      bandId: band.bandId,
      laneId: lane.laneId,
      s,
      status: 'unique',
      bp,
      candidatesBp: [bp],
      segmentRef: { fromRung: enclosing.rungA, toRung: enclosing.rungB, laneId: ruler.laneId },
      validRegion: { fromS: region.fromS, toS: region.toS },
      diagnostics,
      derivationId,
    };
  }

  candidates.push(Math.exp(enclosing.slope * s + enclosing.intercept));
  return finalizeCandidates(candidates, s, enclosing, region, diagnostics, derivationId, band, lane);
}

function finalizeCandidates(
  candidates: number[],
  s: number,
  seg: CalibrationSegment,
  region: { fromS: number; toS: number },
  diagnostics: Diagnostic[],
  derivationId: string,
  band: BandObservation,
  lane: LaneGeometry,
): MolecularWeightResult {
  const sorted = [...new Set(candidates.map((c) => Math.round(c * 100) / 100))].sort((a, b) => a - b);
  return {
    bandId: band.bandId,
    laneId: lane.laneId,
    s,
    status: sorted.length > 1 ? 'candidate-set' : 'interval',
    bp: null,
    candidatesBp: sorted,
    intervalBp: sorted.length === 1 ? { low: sorted[0]!, high: sorted[0]! } : undefined,
    segmentRef: { fromRung: seg.rungA, toRung: seg.rungB, laneId: lane.laneId },
    validRegion: { fromS: region.fromS, toS: region.toS },
    diagnostics,
    derivationId,
  };
}

function nearestSegment(segments: CalibrationSegment[], s: number): CalibrationSegment {
  return segments.reduce((best, seg) => {
    const dBest = Math.min(Math.abs(s - best.sA), Math.abs(s - best.sB));
    const dSeg = Math.min(Math.abs(s - seg.sA), Math.abs(s - seg.sB));
    return dSeg < dBest ? seg : best;
  }, segments[0]!);
}
