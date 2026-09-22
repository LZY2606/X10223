// ladder 配对 + 分段对数线性标定。
// 规则：沿泳道弧长 s（距加样口）单调增大；标称分子量必须严格下降，
// 否则为“非单调标尺”，相应插值段失效（local invalid），不允许越段推断。
import { D, diag } from '../diagnostics.js';
import { inValidRegion, segmentValidRegion } from '../geometry.js';
import { RULE_VERSIONS } from '../versions.js';
import { stableId } from '../ids.js';
import type {
  Calibration,
  Diagnostic,
  FitResidual,
  LadderBandSpec,
  LadderPairing,
  CalibrationSegment,
  ValidRegion,
} from '../types.js';

export interface LadderBandPoint {
  bandId: string;
  s: number;
  centerX: number;
  rankHint?: number; // 配对来源（自动/人工）
}

export interface CalibrateInput {
  calibrationId: string;
  laneId: string;
  ladderSpecId: string;
  ladderBands: LadderBandSpec[];
  observed: LadderBandPoint[];
  paramsVersion: string;
  centerline: Array<{ x: number; y: number }>;
  halfWidthPx: number;
  budget?: { maxPairingPermutations: number };
  forcedPairing?: Array<{ rank: number; bandId: string }>;
}

// 单调对齐：rank 按 s 升序匹配。缺带时由 DP 选出与标称严格单调一致的最长匹配。
export function pairLadderBands(
  nominal: LadderBandSpec[],
  observed: LadderBandPoint[],
  budget: { maxPairingPermutations: number },
  forced?: Array<{ rank: number; bandId: string }>,
): { pairing: LadderPairing[]; diagnostics: Diagnostic[]; budgetExhausted: boolean } {
  const diagnostics: Diagnostic[] = [];
  const byS = [...observed].sort((a, b) => a.s - b.s);
  const ranks = nominal
    .map((b, i) => ({ spec: b, rank: b.rank ?? i + 1, nominal: b.nominal.value }))
    .sort((a, b) => a.rank - b.rank);

  const forcedMap = new Map(forced?.map((f) => [f.rank, f.bandId]) ?? []);
  let nodes = 0;

  // DP：在“rank 顺序 ⇒ s 严格递增”约束下最大化匹配数。
  const memo = new Map<string, number>();
  const choice = new Map<string, number>();
  const solve = (ri: number, oi: number, lastS: number): number => {
    if (ri >= ranks.length || oi >= byS.length) return 0;
    const key = `${ri}:${oi}:${Math.round(lastS * 10)}`;
    const cached = memo.get(key);
    if (cached !== undefined) return cached;
    nodes++;
    if (nodes > budget.maxPairingPermutations) return -1;
    const skipRank = solve(ri + 1, oi, lastS);
    let take = -1;
    const band = byS[oi]!;
    const forcedBand = forcedMap.get(ranks[ri]!.rank);
    const canTake = band.s > lastS + 1e-6 && (!forcedBand || forcedBand === band.bandId);
    if (canTake) {
      const rest = solve(ri + 1, oi + 1, band.s);
      if (rest >= 0) take = 1 + rest;
    }
    const skipObs = solve(ri, oi + 1, lastS);
    const best = Math.max(skipRank, take, skipObs);
    if (best === take && take >= 0) choice.set(key, oi);
    memo.set(key, best);
    return best;
  };

  const total = solve(0, 0, -Infinity);
  if (total < 0) {
    return {
      pairing: [],
      diagnostics: [
        diag(D.BUDGET_EXHAUSTED, 'error', 'ladder 配对搜索超过预算', '/calibration/pairing', {
          failureClass: 'budget_exhausted',
        }),
      ],
      budgetExhausted: true,
    };
  }

  // 回溯
  const matched = new Map<number, string>();
  let ri = 0;
  let oi = 0;
  let lastS = -Infinity;
  while (ri < ranks.length && oi < byS.length) {
    const key = `${ri}:${oi}:${Math.round(lastS * 10)}`;
    const skipRank = solve(ri + 1, oi, lastS);
    const band = byS[oi]!;
    const forcedBand = forcedMap.get(ranks[ri]!.rank);
    const canTake = band.s > lastS + 1e-6 && (!forcedBand || forcedBand === band.bandId);
    let take = -1;
    if (canTake) {
      const rest = solve(ri + 1, oi + 1, band.s);
      if (rest >= 0) take = 1 + rest;
    }
    const skipObs = solve(ri, oi + 1, lastS);
    if (take >= skipRank && take >= skipObs && take >= 0) {
      matched.set(ranks[ri]!.rank, band.bandId);
      lastS = band.s;
      ri++;
      oi++;
    } else if (skipRank >= skipObs) {
      ri++;
    } else {
      oi++;
    }
    void key;
  }

  const pairing: LadderPairing[] = ranks.map((r) => {
    const bandId = matched.get(r.rank);
    const obs = byS.find((b) => b.bandId === bandId);
    return {
      rank: r.rank,
      bandId: bandId ?? '',
      nominalValue: r.nominal,
      s: obs?.s ?? NaN,
      matched: !!obs,
    };
  });

  for (const r of ranks) {
    if (!matched.has(r.rank)) {
      diagnostics.push(
        diag(
          r.spec.present === false ? D.LADDER_BAND_MISSING : D.LADDER_BAND_MISSING,
          'warning',
          `ladder rank ${r.rank}（标称 ${r.nominal} ${r.spec.nominal.unit}）未匹配到条带：缺带或局部无标尺`,
          `/ladderSpec/bands/${r.rank - 1}`,
          { subjectId: `rank:${r.rank}` },
        ),
      );
    }
  }
  for (const band of byS) {
    if (![...matched.values()].includes(band.bandId)) {
      diagnostics.push(
        diag(
          D.LADDER_UNMATCHED_BAND,
          'warning',
          `ladder 泳道中 s=${band.s.toFixed(1)}px 的条带未被任何标称 rank 匹配`,
          `/observed/${band.bandId}`,
          { subjectId: band.bandId },
        ),
      );
    }
  }
  return { pairing, diagnostics, budgetExhausted: false };
}

export function calibrate(input: CalibrateInput): {
  calibration: Calibration;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const budget = input.budget ?? { maxPairingPermutations: 5000 };
  const { pairing, diagnostics: pairDiag, budgetExhausted } = pairLadderBands(
    input.ladderBands,
    input.observed,
    budget,
    input.forcedPairing,
  );
  diagnostics.push(...pairDiag);
  if (budgetExhausted) {
    return {
      calibration: emptyCalibration(input, [], pairing, 'insufficient_points'),
      diagnostics,
    };
  }

  const matched = pairing
    .filter((p) => p.matched)
    .sort((a, b) => a.s - b.s);
  const segments: CalibrationSegment[] = [];
  for (let i = 0; i < matched.length - 1; i++) {
    const a = matched[i]!;
    const b = matched[i + 1]!;
    const logMA = Math.log10(a.nominalValue);
    const logMB = Math.log10(b.nominalValue);
    const nonMonotonic = logMB >= logMA;
    const region: ValidRegion = segmentValidRegion(
      a.s,
      b.s,
      input.centerline,
      input.halfWidthPx,
    );
    const segId = stableId('seg', input.laneId, a.rank, b.rank, input.paramsVersion);
    segments.push({
      id: segId,
      rankA: a.rank,
      rankB: b.rank,
      sA: a.s,
      sB: b.s,
      logMA,
      logMB,
      valid: !nonMonotonic,
      validRegion: region,
      invalidReasonCode: nonMonotonic ? D.CALIBRATION_SEGMENT_NONMONOTONIC : undefined,
      ruleVersion: RULE_VERSIONS.calibration,
      parentDerivationId: '',
    });
    if (nonMonotonic) {
      diagnostics.push(
        diag(
          D.CALIBRATION_SEGMENT_NONMONOTONIC,
          'error',
          `rank ${a.rank}→${b.rank} 标称未随迁移距离下降（${a.nominalValue}→${b.nominalValue}），该段非单调标尺已置为局部失效`,
          `/ladderSpec/bands`,
          { subjectId: segId, failureClass: 'semantic_impossible' },
        ),
      );
    }
  }

  const hasInvalid = segments.some((s) => !s.valid);
  const status: Calibration['status'] =
    matched.length < 2
      ? 'insufficient_points'
      : hasInvalid
        ? 'local_invalid'
        : 'valid';
  if (matched.length < 2) {
    diagnostics.push(
      diag(
        D.CALIBRATION_INSUFFICIENT,
        'error',
        '可匹配 ladder 点不足 2 个，无法建立任何插值段',
        '/calibration',
        { failureClass: 'semantic_impossible' },
      ),
    );
  }
  if (
    input.ladderBands
      .slice()
      .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0))
      .some((b, i, arr) => i > 0 && b.nominal.value >= arr[i - 1]!.nominal.value)
  ) {
    diagnostics.push(
      diag(
        D.LADDER_NON_MONOTONIC,
        'warning',
        'ladder 标称序列整体非单调：标尺声明语义可疑，仅单调区间有效',
        '/ladderSpec/bands',
      ),
    );
  }

  const residuals = computeResiduals(matched, segments);
  const calibration: Calibration = {
    id: input.calibrationId,
    laneId: input.laneId,
    ladderSpecId: input.ladderSpecId,
    status,
    segments,
    globalResiduals: residuals,
    pairing,
    paramsVersion: input.paramsVersion,
    ruleVersion: RULE_VERSIONS.calibration,
    diagnosticCodes: [...new Set(diagnostics.map((d) => d.code))],
  };
  return { calibration, diagnostics };
}

function computeResiduals(
  matched: LadderPairing[],
  segments: CalibrationSegment[],
): FitResidual[] {
  // 对所有“有效段”做一条全局 logM~s 直线，逐点报告残差（拟合残差视图证据）
  const validSegs = segments.filter((s) => s.valid);
  if (validSegs.length === 0) {
    return matched.map((m) => ({
      bandId: m.bandId,
      s: m.s,
      observedLogM: Math.log10(m.nominalValue),
      predictedLogM: NaN,
      residualLogM: NaN,
      inValidRegion: false,
    }));
  }
  const xs = matched.filter((m) =>
    validSegs.some((s) => inValidRegion(s.validRegion, m.s)),
  );
  const n = xs.length || 1;
  const meanS = xs.reduce((a, m) => a + m.s, 0) / n;
  const meanL = xs.reduce((a, m) => a + Math.log10(m.nominalValue), 0) / n;
  let num = 0;
  let den = 0;
  for (const m of xs) {
    num += (m.s - meanS) * (Math.log10(m.nominalValue) - meanL);
    den += (m.s - meanS) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  const intercept = meanL - slope * meanS;
  return matched.map((m) => {
    const observed = Math.log10(m.nominalValue);
    const predicted = intercept + slope * m.s;
    const inRegion = validSegs.some((s) => inValidRegion(s.validRegion, m.s));
    return {
      bandId: m.bandId,
      s: m.s,
      observedLogM: Number(observed.toFixed(5)),
      predictedLogM: Number(predicted.toFixed(5)),
      residualLogM: Number((observed - predicted).toFixed(5)),
      inValidRegion: inRegion,
    };
  });
}

function emptyCalibration(
  input: CalibrateInput,
  segments: CalibrationSegment[],
  pairing: LadderPairing[],
  status: Calibration['status'],
): Calibration {
  return {
    id: input.calibrationId,
    laneId: input.laneId,
    ladderSpecId: input.ladderSpecId,
    status,
    segments,
    globalResiduals: [],
    pairing,
    paramsVersion: input.paramsVersion,
    ruleVersion: RULE_VERSIONS.calibration,
    diagnosticCodes: [D.BUDGET_EXHAUSTED],
  };
}
