import type {
  BandMaterial,
  CalibrationParams,
  CalibrationResult,
  FitSegment,
  LadderMapping,
  LadderSpec,
  MassResult
} from './types';
import type { Diagnostic } from '../shared/diagnostics';
import { stableId } from '../shared/hash';
import { diag } from '../shared/diagnostics';

export interface LadderMappingCandidate {
  id: string;
  mappings: LadderMapping[];
  usedBandIds: string[];
  missingOrdinals: number[];
  fitScore: number; // 越小越好
}

/** 严格按迁移顺序（弧长 s 递增）排列的条带。 */
function sortBands(bands: BandMaterial[]): BandMaterial[] {
  return [...bands].sort((a, b) => (a.center.y === b.center.y ? a.center.x - b.center.x : a.center.y - b.center.y));
}

function logScore(mappings: LadderMapping[]): number {
  if (mappings.length < 2) return Infinity;
  const rows = mappings.map((m) => ({ s: m.sPx, lm: Math.log10(m.massBp) }));
  const n = rows.length;
  const ms = rows.reduce((a, r) => a + r.s, 0) / n;
  const ml = rows.reduce((a, r) => a + r.lm, 0) / n;
  let num = 0;
  let den = 0;
  for (const r of rows) {
    num += (r.s - ms) * (r.lm - ml);
    den += (r.s - ms) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = ml - slope * ms;
  let score = 0;
  for (const r of rows) {
    score += (r.lm - (slope * r.s + intercept)) ** 2;
  }
  return score / n;
}

/**
 * ladder 缺带：生成所有“标称点等距跳过缺失条带”的合法对齐，
 * 无法唯一决定时全部保留（候选集），绝不偷偷补默认值。
 */
export function alignLadder(
  spec: LadderSpec,
  bands: BandMaterial[],
  sByBand: Map<string, number>,
  expectedMaxSkip = 2
): { candidates: LadderMappingCandidate[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const observed = sortBands(bands).map((b) => ({ band: b, s: sByBand.get(b.id) ?? b.center.y }));
  const nominal = [...spec.nominal].sort((a, b) => a.ordinal - b.ordinal);
  const nNom = nominal.length;
  const nObs = observed.length;

  if (nObs > nNom) {
    diagnostics.push(
      diag('LADDER_EXTRA_BANDS', 'SEMANTIC_UNRESOLVABLE', `ladder 观测条带 ${nObs} 条多于标称 ${nNom} 条，无法对齐`, [
        { material: spec.id }, { material: spec.laneId }
      ])
    );
    return { candidates: [], diagnostics };
  }

  const candidates: LadderMappingCandidate[] = [];
  const pick = (selected: number[]) => {
    if (selected.length === nObs) {
      const ordinals = selected.map((i) => nominal[i]);
      const mappings: LadderMapping[] = selected.map((nomIdx, obsIdx) => ({
        bandOrdinal: nominal[nomIdx].ordinal,
        bandId: observed[obsIdx].band.id,
        massBp: nominal[nomIdx].massBp,
        sPx: observed[obsIdx].s
      }));
      const missingOrdinals = nominal
        .map((x) => x.ordinal)
        .filter((o) => !ordinals.some((x) => x.ordinal === o));
      const score = logScore(mappings);
      candidates.push({
        id: stableId('lmap', [
          spec.id,
          mappings.map((m) => [m.bandId, m.bandOrdinal, Math.round(m.sPx * 10) / 10])
        ]),
        mappings,
        usedBandIds: mappings.map((m) => m.bandId),
        missingOrdinals,
        fitScore: score
      });
      return;
    }
    const nextObs = selected.length;
    const prevNom = nextObs === 0 ? -1 : selected[nextObs - 1];
    const remainingObs = nObs - nextObs;
    for (let nomIdx = prevNom + 1; nomIdx <= nNom - remainingObs; nomIdx++) {
      const skip = nextObs === 0 ? nomIdx : nomIdx - prevNom - 1;
      if (skip <= expectedMaxSkip) pick([...selected, nomIdx]);
    }
  };
  pick([]);

  candidates.sort((a, b) => a.fitScore - b.fitScore || a.id.localeCompare(b.id));

  if (nObs < nNom) {
    const best = candidates[0];
    diagnostics.push(
      diag(
        'LADDER_MISSING_BANDS',
        'SEMANTIC_UNRESOLVABLE',
        `ladder 缺带：观测 ${nObs}/${nNom}，缺失标称序号 ${best?.missingOrdinals.join(',') ?? '?'}；保留 ${candidates.length} 种合法对齐`,
        [{ material: spec.id }, { material: spec.laneId }],
        'warning'
      )
    );
  }
  if (!candidates.length) {
    diagnostics.push(diag('LADDER_ALIGNMENT_EMPTY', 'SEMANTIC_UNRESOLVABLE', 'ladder 不存在任何合法对齐', [{ material: spec.id }]));
  }
  return { candidates, diagnostics };
}

// ---------- 校准构建 ----------

export interface CalibrationInput {
  spec: LadderSpec;
  ladderBands: BandMaterial[];
  sByBand: Map<string, number>;
  params: CalibrationParams;
  imageId: string;
  chosenMappingId?: string;
}

function fitLogLinear(rows: { s: number; lm: number }[]) {
  const n = rows.length;
  const ms = rows.reduce((a, r) => a + r.s, 0) / n;
  const ml = rows.reduce((a, r) => a + r.lm, 0) / n;
  let num = 0;
  let den = 0;
  for (const r of rows) {
    num += (r.s - ms) * (r.lm - ml);
    den += (r.s - ms) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = ml - slope * ms;
  return { slope, intercept };
}

function nominalMonotonic(spec: LadderSpec): boolean {
  const ordered = [...spec.nominal].sort((a, b) => a.ordinal - b.ordinal);
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].massBp >= ordered[i - 1].massBp) return false;
  }
  return true;
}

export function buildCalibration(input: CalibrationInput): {
  result: CalibrationResult | null;
  mappingCandidates: LadderMappingCandidate[];
  chosenMappingId: string | null;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const { spec, ladderBands, sByBand, params } = input;
  const aligned = alignLadder(spec, ladderBands, sByBand);
  diagnostics.push(...aligned.diagnostics);
  if (!aligned.candidates.length) {
    return { result: null, mappingCandidates: [], chosenMappingId: null, diagnostics };
  }
  const chosen =
    aligned.candidates.find((c) => c.id === input.chosenMappingId) ?? aligned.candidates[0];

  const monotonic = nominalMonotonic(spec);
  if (!monotonic) {
    diagnostics.push(
      diag(
        'NONMONOTONIC_RULER',
        'SEMANTIC_UNRESOLVABLE',
        'ladder 标称值随迁移弧长非严格递减，标尺非单调：不能内插任何分子量',
        [{ material: spec.id }, { material: spec.laneId }]
      )
    );
  }

  const calId = stableId('cal', [
    spec.id,
    params.version,
    chosen.mappings.map((m) => [m.bandId, m.bandOrdinal, Math.round(m.sPx * 10) / 10])
  ]);

  const mappings = [...chosen.mappings].sort((a, b) => a.sPx - b.sPx);
  const validS: [number, number] = [mappings[0].sPx, mappings[mappings.length - 1].sPx];

  let segments: FitSegment[] = [];
  if (monotonic) {
    if (params.method === 'global-loglinear') {
      const { slope, intercept } = fitLogLinear(mappings.map((m) => ({ s: m.sPx, lm: Math.log10(m.massBp) })));
      segments = [
        {
          id: stableId('seg', [calId, mappings[0].bandOrdinal, mappings[mappings.length - 1].bandOrdinal]),
          ordinalA: mappings[0].bandOrdinal,
          ordinalB: mappings[mappings.length - 1].bandOrdinal,
          sApx: mappings[0].sPx,
          sBpx: mappings[mappings.length - 1].sPx,
          massA: mappings[0].massBp,
          massB: mappings[mappings.length - 1].massBp,
          validSPx: validS,
          logSlope: slope,
          logIntercept: intercept
        }
      ];
    } else {
      for (let i = 1; i < mappings.length; i++) {
        const a = mappings[i - 1];
        const b = mappings[i];
        const slope = (Math.log10(b.massBp) - Math.log10(a.massBp)) / (b.sPx - a.sPx || 1);
        segments.push({
          id: stableId('seg', [calId, a.bandOrdinal, b.bandOrdinal]),
          ordinalA: a.bandOrdinal,
          ordinalB: b.bandOrdinal,
          sApx: a.sPx,
          sBpx: b.sPx,
          massA: a.massBp,
          massB: b.massBp,
          validSPx: [a.sPx, b.sPx],
          logSlope: slope,
          logIntercept: Math.log10(a.massBp) - slope * a.sPx
        });
      }
    }
  }

  const residuals = monotonic
    ? mappings.map((m) => {
        const seg = segmentAt(segments, m.sPx)!;
        const observedBp = 10 ** (seg.logSlope * m.sPx + seg.logIntercept);
        const residualBp = observedBp - m.massBp;
        return {
          bandId: m.bandId,
          ordinal: m.bandOrdinal,
          observedBp: Math.round(observedBp),
          nominalBp: m.massBp,
          residualBp: Math.round(residualBp),
          residualFrac: Math.round((residualBp / m.massBp) * 1e4) / 1e4
        };
      })
    : [];
  const rmsResidualFrac = residuals.length
    ? Math.round(Math.sqrt(residuals.reduce((a, r) => a + r.residualFrac ** 2, 0) / residuals.length) * 1e4) / 1e4
    : 0;

  const result: CalibrationResult = {
    id: calId,
    ladderSpecId: spec.id,
    laneId: spec.laneId,
    imageId: input.imageId,
    paramsVersion: params.version,
    mappings,
    segments,
    validSPx: validS,
    residuals,
    rmsResidualFrac,
    monotonic,
    diagnostics
  };
  return { result, mappingCandidates: aligned.candidates, chosenMappingId: chosen.id, diagnostics };
}

export function segmentAt(segments: FitSegment[], s: number): FitSegment | null {
  if (params0Global(segments)) {
    const only = segments[0];
    return s >= only.validSPx[0] && s <= only.validSPx[1] ? only : null;
  }
  return segments.find((g) => s >= g.validSPx[0] && s <= g.validSPx[1]) ?? null;
}

function params0Global(segments: FitSegment[]): boolean {
  return segments.length === 1;
}

// ---------- 分子量推断 ----------

export interface InferInput {
  band: BandMaterial;
  sPx: number;
  calibration: CalibrationResult;
  clusterBandIds: string[];
  clusterBands: BandMaterial[];
  sByBand: Map<string, number>;
}

function bpAt(seg: FitSegment, s: number): number {
  return 10 ** (seg.logSlope * s + seg.logIntercept);
}

export function inferMass(input: InferInput): MassResult {
  const { band, sPx, calibration } = input;
  const diagnostics: Diagnostic[] = [];
  const baseIdParts = [calibration.id, band.id, calibration.paramsVersion, Math.round(sPx * 10) / 10, band.flag];
  const id = stableId('mass', baseIdParts);

  if (!calibration.monotonic || calibration.segments.length === 0) {
    diagnostics.push(
      diag('MASS_RULER_INVALID', 'SEMANTIC_UNRESOLVABLE', '标尺非单调或缺少有效插值段，分子量不可推断', [
        { material: band.laneId }, { material: band.id }
      ])
    );
    return emptyResult(id, band, sPx, calibration, diagnostics, 'invalid');
  }

  const seg = segmentAt(calibration.segments, sPx);
  if (!seg) {
    diagnostics.push(
      diag(
        'MASS_OUTSIDE_VALID_REGION',
        'SEMANTIC_UNRESOLVABLE',
        `s=${Math.round(sPx)}px 落在标尺有效区域 [${Math.round(calibration.validSPx[0])}, ${Math.round(calibration.validSPx[1])}] 之外，禁止外推`,
        [{ material: band.laneId }, { material: band.id }]
      )
    );
    return emptyResult(id, band, sPx, calibration, diagnostics, 'out-of-range');
  }

  const center = Math.round(bpAt(seg, sPx));

  if (band.flag === 'overlap') {
    const candidates = input.clusterBands
      .map((b) => {
        const bs = input.sByBand.get(b.id) ?? sPx;
        const g = segmentAt(calibration.segments, bs);
        return g ? { bandId: b.id, massBp: Math.round(bpAt(g, bs)), segmentId: g.id } : null;
      })
      .filter((x): x is { bandId: string; massBp: number; segmentId: string } => x !== null)
      .sort((a, b) => a.massBp - b.massBp || a.bandId.localeCompare(b.bandId));
    diagnostics.push(
      diag('MASS_OVERLAP_CANDIDATES', 'SEMANTIC_UNRESOLVABLE', '重叠条带无法唯一归属，保留簇内全部合法候选', [
        { material: band.laneId }, { material: band.id }
      ], 'warning')
    );
    const lo = candidates[0]?.massBp ?? center;
    const hi = candidates[candidates.length - 1]?.massBp ?? center;
    return resultShape(id, band, sPx, calibration, null, [Math.min(lo, hi), Math.max(lo, hi)], candidates, 'candidate-set', diagnostics);
  }

  if (band.flag === 'saturated' || band.flag === 'smear') {
    const w = Math.max(band.widthPx, 6);
    const sLo = Math.max(calibration.validSPx[0], sPx - w);
    const sHi = Math.min(calibration.validSPx[1], sPx + w);
    const bpHi = Math.round(bpAt(segmentAt(calibration.segments, sLo) ?? seg, sLo));
    const bpLo = Math.round(bpAt(segmentAt(calibration.segments, sHi) ?? seg, sHi));
    const interval: [number, number] = [Math.min(bpLo, bpHi), Math.max(bpLo, bpHi)];
    diagnostics.push(
      diag(
        band.flag === 'saturated' ? 'MASS_SATURATED_INTERVAL' : 'MASS_SMEAR_INTERVAL',
        'SEMANTIC_UNRESOLVABLE',
        `${band.flag === 'saturated' ? '饱和' : '拖尾'}条带只能给出区间 ${interval[0]}..${interval[1]} bp`,
        [{ material: band.laneId }, { material: band.id }],
        'warning'
      )
    );
    return resultShape(id, band, sPx, calibration, null, interval, [{ bandId: band.id, massBp: center, segmentId: seg.id }], 'interval', diagnostics);
  }

  return resultShape(id, band, sPx, calibration, center, null, [{ bandId: band.id, massBp: center, segmentId: seg.id }], 'resolved', diagnostics);
}

function emptyResult(
  id: string,
  band: BandMaterial,
  sPx: number,
  calibration: CalibrationResult,
  diagnostics: Diagnostic[],
  status: MassResult['status']
): MassResult {
  return resultShape(id, band, sPx, calibration, null, null, [], status, diagnostics);
}

function resultShape(
  id: string,
  band: BandMaterial,
  sPx: number,
  calibration: CalibrationResult,
  singleBp: number | null,
  intervalBp: [number, number] | null,
  candidates: MassResult['candidates'],
  status: MassResult['status'],
  diagnostics: Diagnostic[]
): MassResult {
  return {
    id,
    bandId: band.id,
    laneId: band.laneId,
    calibrationId: calibration.id,
    sPx: Math.round(sPx * 10) / 10,
    singleBp,
    intervalBp,
    candidates,
    status,
    diagnostics,
    parentResults: [calibration.id],
    inputDigest: '',
    paramsVersion: calibration.paramsVersion,
    computedAt: new Date(0).toISOString()
  };
}
