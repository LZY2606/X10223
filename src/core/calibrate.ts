import type {
  BandObservation, CalibrationResult, Diagnostic, LadderSpec, LaneBoundary,
  MwCandidate, MwResult, ParameterSet, QValue, ValidSegment,
} from '../shared/types.js';
import { stableId } from './ids.js';

export interface OrderedLadderPoint { id: string; s: number; mw: number; rawNominal: string; }

export interface CalibrateOutcome {
  calibration: CalibrationResult | null;
  ordered: OrderedLadderPoint[];
  error: Diagnostic | null;
}

export interface CalibrateInput {
  lane: LaneBoundary;
  ladder: LadderSpec;
  ladderBands: BandObservation[];
  imageId: string;
  params: ParameterSet;
  parentEventId: string;
  at: string;
}

function q(v: number, unit: QValue['unit'], raw?: string): QValue {
  return { value: v, unit, raw };
}

// 局部标尺：只在相邻有效 ladder 点构成的插值段内可信，缺带段降级，非单调整体拒绝。
export function calibrate(input: CalibrateInput): CalibrateOutcome {
  const { lane, ladder, ladderBands, params, parentEventId, imageId } = input;
  const diagnostics: Diagnostic[] = [];
  const present: OrderedLadderPoint[] = [];

  ladder.points.forEach((point, i) => {
    const band = ladderBands[i];
    if (point.missing || !band) {
      diagnostics.push({
        code: 'MISSING_BAND', severity: 'warning',
        message: `Ladder 标称 ${point.nominal.raw ?? point.nominal.value}${ladder.unit} 的条带缺失，跨越该点的插值段降级为候选`,
        affectedObjectIds: [point.id],
        position: band ? band.provenance : undefined,
      });
      return;
    }
    if (typeof point.nominal.value !== 'number' || !Number.isFinite(point.nominal.value)) {
      diagnostics.push({
        code: 'INCOMPLETE_INPUT', severity: 'error',
        message: `Ladder 点 ${point.id} 标称值无法转换：${point.nominal.convertError ?? '未知原因'}，原值 ${point.nominal.raw ?? '空'} 保留在原位置`,
        affectedObjectIds: [point.id],
      });
      return;
    }
    present.push({ id: point.id, s: band.s, mw: point.nominal.value, rawNominal: point.nominal.raw ?? String(point.nominal.value) });
  });

  if (present.length < 2) {
    return {
      calibration: null, ordered: [], error: {
        code: 'SEMANTIC_UNRESOLVABLE', severity: 'error',
        message: '有效 ladder 点不足 2 个，无法建立任何插值段',
        affectedObjectIds: [lane.id, ladder.id],
      },
    };
  }

  present.sort((a, b) => a.s - b.s);
  for (let i = 1; i < present.length; i++) {
    if (present[i].s <= present[i - 1].s || present[i].mw >= present[i - 1].mw) {
      return {
        calibration: null, ordered: [], error: {
          code: 'NON_MONOTONIC_RULER', severity: 'error',
          message: `标尺非单调（点 ${present[i - 1].id}→${present[i].id}），迁移量与标称分子量未保持严格反序，标尺整体不可用`,
          affectedObjectIds: [present[i - 1].id, present[i].id],
        },
      };
    }
  }

  const segments: ValidSegment[] = [];
  for (let i = 0; i < present.length - 1; i++) {
    const ordA = ladder.points.findIndex((x) => x.id === present[i].id);
    const ordB = ladder.points.findIndex((x) => x.id === present[i + 1].id);
    segments.push({
      ladderPointIds: [present[i].id, present[i + 1].id],
      sStart: present[i].s, sEnd: present[i + 1].s, valid: true,
      reason: ordB - ordA > 1 ? 'MISSING_BAND' : undefined,
    });
  }

  const calibration: CalibrationResult = {
    id: stableId('cal', { laneId: lane.id, ladderId: ladder.id, points: present.map((p) => [p.id, round(p.s), p.mw]), pv: params.version }),
    kind: 'calibration',
    laneId: lane.id,
    ladderSpecId: ladder.id,
    imageId,
    paramVersion: params.version,
    parentEventId,
    parents: [lane.id, ladder.id, ...ladderBands.map((b) => b.id)],
    inputSummary: {
      laneId: lane.id, ladderSpecId: ladder.id, pointCount: present.length,
      points: present.map((p) => ({ id: p.id, s: round(p.s), mw: p.mw })),
      ladderBands: ladderBands.map((b, i) => ({ point: ladder.points[i].id, bandId: b?.id ?? null, missing: !b })),
    },
    validSegments: segments,
    validRegion: { sMin: present[0].s, sMax: present[present.length - 1].s },
    adopted: true,
    outcome: 'ok',
    diagnostics,
    createdAt: input.at,
  };
  return { calibration, ordered: present, error: null };
}

export function inferMw(args: {
  bands: BandObservation[];
  calibration: CalibrationResult;
  ordered: OrderedLadderPoint[];
  ladder: LadderSpec;
  lane: LaneBoundary;
  params: ParameterSet;
  parentEventId: string;
  at: string;
}): MwResult {
  const { bands, calibration, ordered, ladder, lane, params, parentEventId } = args;
  const diagnostics: Diagnostic[] = [...calibration.diagnostics];
  const candidates = bands.map((band) => mwForBand(band, ordered, calibration, params, diagnostics, ladder));

  return {
    id: stableId('mw', { calId: calibration.id, pv: params.version, bands: candidates.map((c) => [c.evidenceBandIds, round(c.s), c.status]) }),
    kind: 'mw_inference',
    laneId: lane.id,
    calibrationId: calibration.id,
    paramVersion: params.version,
    parentEventId,
    parents: [calibration.id, lane.id, ...bands.map((b) => b.id)],
    inputSummary: {
      calibrationId: calibration.id, bandCount: bands.length,
      bands: bands.map((b) => ({ id: b.id, s: round(b.s), sat: b.saturated, smear: b.smear })),
    },
    candidates,
    adopted: true,
    outcome: 'ok',
    diagnostics,
    createdAt: args.at,
  };
}

function segmentFor(s: number, ordered: OrderedLadderPoint[], calibration: CalibrationResult) {
  for (let i = 0; i < ordered.length - 1; i++) {
    if (s >= ordered[i].s && s <= ordered[i + 1].s) {
      const seg = calibration.validSegments.find(
        (v) => v.ladderPointIds[0] === ordered[i].id && v.ladderPointIds[1] === ordered[i + 1].id,
      );
      return { lo: ordered[i], hi: ordered[i + 1], seg };
    }
  }
  return null;
}

function semilog(lo: OrderedLadderPoint, hi: OrderedLadderPoint, s: number): number {
  const t = (s - lo.s) / (hi.s - lo.s);
  return lo.mw * Math.pow(hi.mw / lo.mw, t);
}

function mwForBand(
  band: BandObservation, ordered: OrderedLadderPoint[], calibration: CalibrationResult,
  params: ParameterSet, diagnostics: Diagnostic[], ladder: LadderSpec,
): MwCandidate {
  const base = {
    id: stableId('mwc', { bandId: band.id, calId: calibration.id, pv: params.version }),
    s: band.s, evidenceBandIds: [band.id], ladderPointIds: [] as string[], valid: true,
    mw: { value: null, unit: ladder.unit, raw: null as string | null } as QValue,
  };
  const degraded = (reason: MwCandidate['invalidReason'], message: string, code: Diagnostic['code']): MwCandidate => {
    diagnostics.push({ code, severity: 'error', message, position: band.provenance, affectedObjectIds: [band.id] });
    return { ...base, status: 'indeterminate', valid: false, invalidReason: reason };
  };

  if (band.s < calibration.validRegion.sMin || band.s > calibration.validRegion.sMax) {
    if (params.calibration.refuseExtrapolation) {
      return degraded('EXTRAPOLATION_REFUSED',
        `s=${Math.round(band.s)}px 超出 ladder 有效区域 [${Math.round(calibration.validRegion.sMin)}, ${Math.round(calibration.validRegion.sMax)}]px，拒绝外推`,
        'EXTRAPOLATION_REFUSED');
    }
  }
  const found = segmentFor(band.s, ordered, calibration);
  if (!found) {
    return degraded('OUTSIDE_VALID_REGION', `s=${Math.round(band.s)}px 不落在任何有效插值段内`, 'OUTSIDE_VALID_REGION');
  }
  const { lo, hi, seg } = found;
  const spanMissing = seg?.reason === 'MISSING_BAND';
  const pts = [lo.id, hi.id];
  const center = semilog(lo, hi, band.s);
  const segmentId = stableId('seg', pts);

  if (band.saturated || band.smear) {
    const low = semilog(lo, hi, band.s + 6);
    const high = semilog(lo, hi, band.s - 6);
    diagnostics.push({
      code: band.saturated ? 'SATURATED_BAND' : 'SMEAR_BAND', severity: 'warning',
      message: `${band.saturated ? '饱和' : '拖尾'}条带只能标为候选/区间：${Math.round(low)}–${Math.round(high)} ${ladder.unit}`,
      position: band.provenance, affectedObjectIds: [band.id],
    });
    return {
      ...base, status: 'candidate', ladderPointIds: pts, segmentId,
      mw: q(Math.round(center), ladder.unit, `~${Math.round(center)} ${ladder.unit} (候选)`),
      interval: { low: q(Math.round(low), ladder.unit), high: q(Math.round(high), ladder.unit) },
      valid: !spanMissing, invalidReason: spanMissing ? 'MISSING_BAND' : undefined,
    };
  }

  if (band.provenance.uncertaintyPx !== undefined && band.provenance.uncertaintyPx >= 4) {
    const shifts = [-5, 0, 5].map((d) => semilog(lo, hi, band.s + d));
    diagnostics.push({
      code: 'BAND_OVERLAP', severity: 'warning',
      message: `重叠条带保留全部 ${shifts.length} 个合法候选：${shifts.map((x) => Math.round(x)).join('/')} ${ladder.unit}`,
      position: band.provenance, affectedObjectIds: [band.id],
    });
    return {
      ...base, status: 'interval', ladderPointIds: pts, segmentId,
      mw: q(Math.round(center), ladder.unit, `~${Math.round(center)} ${ladder.unit} (区间)`),
      interval: { low: q(Math.round(shifts[2]), ladder.unit), high: q(Math.round(shifts[0]), ladder.unit) },
      altCandidates: shifts.map((x) => q(Math.round(x), ladder.unit)),
      valid: !spanMissing, invalidReason: spanMissing ? 'MISSING_BAND' : undefined,
    };
  }

  if (spanMissing) {
    const low = semilog(lo, hi, band.s + 4), high = semilog(lo, hi, band.s - 4);
    return {
      ...base, status: 'candidate', ladderPointIds: pts, segmentId,
      mw: q(Math.round(center), ladder.unit, `~${Math.round(center)} ${ladder.unit} (缺带跨度候选)`),
      interval: { low: q(Math.round(low), ladder.unit), high: q(Math.round(high), ladder.unit) },
      valid: false, invalidReason: 'MISSING_BAND',
    };
  }

  return {
    ...base, status: 'unique', ladderPointIds: pts, segmentId,
    mw: q(Math.round(center), ladder.unit, `${Math.round(center)} ${ladder.unit}`),
  };
}

function round(v: number): number { return Math.round(v * 100) / 100; }
