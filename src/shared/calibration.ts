import type {
  BandCandidate,
  CalibrationParams,
  Finding,
  LadderMaterial,
  MwEstimate,
  RulerCalibrationResult,
  RulerKnot,
  RulerSegment
} from './types';
import { contentId } from './ids';

interface MatchedPeak {
  ordinal: number;
  sPx: number;
  x: number;
  y: number;
  missing: boolean;
}

/**
 * 把检测到的 ladder 峰与标称带按序数单调对齐（确定性 DP）。
 * 等价输入必然得到相同顺序；存在多个等价最优对齐时记录歧义 finding，
 * 但仍返回词典序最小的对齐作为被采纳结果，全部等价假设计数写入 data。
 */
export function alignLadder(
  nominal: { ordinal: number; mw: number }[],
  peaks: { sPx: number; x: number; y: number }[],
  tolerancePx: number
): { matched: MatchedPeak[]; ambiguityCount: number; findings: Finding[] } {
  const findings: Finding[] = [];
  const n = nominal.length;
  const m = peaks.length;
  const sortedPeaks = [...peaks].sort((a, b) => a.sPx - b.sPx);

  /**
   * 对齐策略（确定性）：
   *  ladder 的 log10(mw) 与迁移距离 s 近似线性。枚举峰序列中所有长度 n 的子序列
   *  （缺带时子序列允许跨序数映射：用组合枚举 n 选 k 个标称保留），对每个候选
   *  做最小二乘并以残差为代价；最优要求残差中位数 <= tolerancePx 对应的对数残差。
   *  平局取词典序（起始峰索引最小）。等价最优数量写入 ambiguityCount。
   */
  interface Candidate {
    pairs: { nominalIdx: number; peakIdx: number }[];
    cost: number;
  }
  const candidates: Candidate[] = [];
  const maxMissing = Math.max(0, n - 2);
  for (let keep = Math.min(n, m); keep >= Math.max(2, n - maxMissing); keep -= 1) {
    forEachCombination(n, keep, (nominalPick) => {
      forEachCombination(m, keep, (peakPick) => {
        // 单调：nominalPick 升序、peakPick 升序，天然保持序数/距离单调
        const xs = peakPick.map((p) => sortedPeaks[p].sPx);
        const ys = nominalPick.map((idx) => Math.log10(nominal[idx].mw));
        const rmseLog = linearRmse(xs, ys);
        const slope = linearSlope(xs, ys);
        if (slope >= 0) return; // 分子量必须随迁移距离下降
        // 换算为像素代价：|残差(s)| ~ |残差log|/|slope|
        const pxCost = rmseLog / Math.abs(slope) + (n - keep) * tolerancePx;
        candidates.push({
          pairs: nominalPick.map((ni, k) => ({ nominalIdx: ni, peakIdx: peakPick[k] })),
          cost: pxCost
        });
      });
    });
  }

  if (candidates.length === 0) {
    for (let ord = 0; ord < n; ord += 1) {
      findings.push({
        code: 'MISSING_LADDER_BAND',
        severity: 'warning',
        message: `ladder 第 ${nominal[ord].ordinal} 条标称带（${nominal[ord].mw}）未检测到`,
        subject: { kind: 'ladder-band', id: `ladder-${nominal[ord].ordinal}`, ordinal: nominal[ord].ordinal },
        data: { nominalMw: nominal[ord].mw }
      });
    }
    return {
      matched: nominal.map((band) => ({ ordinal: band.ordinal, sPx: NaN, x: NaN, y: NaN, missing: true })),
      ambiguityCount: 0,
      findings
    };
  }

  candidates.sort((a, b) => {
    if (a.cost !== b.cost) return a.cost - b.cost;
    const ka = a.pairs.map((p) => p.peakIdx).join(',');
    const kb = b.pairs.map((p) => p.peakIdx).join(',');
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const bestCost = candidates[0].cost;
  const tolerance = Math.max(1e-6, bestCost * 1e-9);
  const tied = candidates.filter((c) => Math.abs(c.cost - bestCost) <= tolerance);
  const best = tied[0];

  const matchedByNominal = new Map<number, MatchedPeak>();
  for (const pair of best.pairs) {
    const peak = sortedPeaks[pair.peakIdx];
    matchedByNominal.set(pair.nominalIdx, {
      ordinal: nominal[pair.nominalIdx].ordinal,
      sPx: peak.sPx,
      x: peak.x,
      y: peak.y,
      missing: false
    });
  }
  const matched: MatchedPeak[] = [];
  for (let ord = 0; ord < n; ord += 1) {
    const found = matchedByNominal.get(ord);
    if (found) {
      matched.push(found);
    } else {
      matched.push({ ordinal: nominal[ord].ordinal, sPx: NaN, x: NaN, y: NaN, missing: true });
      findings.push({
        code: 'MISSING_LADDER_BAND',
        severity: 'warning',
        message: `ladder 第 ${nominal[ord].ordinal} 条标称带（${nominal[ord].mw}）未检测到，标尺该 knot 缺失`,
        subject: { kind: 'ladder-band', id: `ladder-${nominal[ord].ordinal}`, ordinal: nominal[ord].ordinal },
        data: { nominalMw: nominal[ord].mw }
      });
    }
  }
  matched.sort((a, b) => a.ordinal - b.ordinal);

  if (tied.length > 1) {
    findings.push({
      code: 'AMBIGUOUS_LADDER_ALIGNMENT',
      severity: 'warning',
      message: '存在多个等价 ladder 对齐，已采纳词典序最小对齐',
      subject: { kind: 'ruler', id: 'ruler' },
      data: { alignmentCount: tied.length }
    });
  }
  return { matched, ambiguityCount: tied.length, findings };
}

function forEachCombination(total: number, pick: number, fn: (picked: number[]) => void): void {
  const current: number[] = [];
  const recurse = (start: number) => {
    if (current.length === pick) {
      fn([...current]);
      return;
    }
    for (let i = start; i <= total - (pick - current.length); i += 1) {
      current.push(i);
      recurse(i + 1);
      current.pop();
    }
  };
  recurse(0);
}

function linearRmse(xs: number[], ys: number[]): number {
  const fit = leastSquares(xs, ys);
  let sumSq = 0;
  for (let i = 0; i < xs.length; i += 1) {
    const residual = ys[i] - (fit.intercept + fit.slope * xs[i]);
    sumSq += residual * residual;
  }
  return Math.sqrt(sumSq / xs.length);
}

function linearSlope(xs: number[], ys: number[]): number {
  return leastSquares(xs, ys).slope;
}

function leastSquares(xs: number[], ys: number[]): { intercept: number; slope: number } {
  const n = xs.length;
  const sx = xs.reduce((a, b) => a + b, 0);
  const sy = ys.reduce((a, b) => a + b, 0);
  const sxx = xs.reduce((a, b) => a + b * b, 0);
  const sxy = xs.reduce((a, b, i) => a + b * ys[i], 0);
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { intercept, slope };
}

export interface LinearFit {
  intercept: number;
  slope: number;
}

/** log10(mw) = a + b*s 最小二乘；mw 随迁移距离 s 增大而减小，故 slope < 0 */
export function fitLogLinear(knots: RulerKnot[]): LinearFit {
  const present = knots.filter((k) => !k.missing && k.nominalMw > 0);
  const n = present.length;
  const sx = present.reduce((sum, k) => sum + k.sPx, 0);
  const sy = present.reduce((sum, k) => sum + Math.log10(k.nominalMw), 0);
  const sxx = present.reduce((sum, k) => sum + k.sPx * k.sPx, 0);
  const sxy = present.reduce((sum, k) => sum + k.sPx * Math.log10(k.nominalMw), 0);
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  return { intercept, slope };
}

export function buildCalibration(
  ladder: LadderMaterial,
  peaks: { sPx: number; x: number; y: number }[],
  params: CalibrationParams
): RulerCalibrationResult {
  const nominal = ladder.bands
    .map((b) => ({ ordinal: b.ordinal, mw: b.mw.value }))
    .sort((a, b) => a.ordinal - b.ordinal);
  const alignment = alignLadder(nominal, peaks, params.overlapDistancePx * 2 + 10);

  const knots: RulerKnot[] = alignment.matched.map((match) => {
    const band = ladder.bands.find((b) => b.ordinal === match.ordinal);
    return {
      ordinal: match.ordinal,
      nominalMw: band?.mw.value ?? NaN,
      unit: ladder.unit,
      sPx: round2(match.sPx),
      x: round2(match.x),
      y: round2(match.y),
      missing: match.missing
    };
  });

  const present = knots.filter((k) => !k.missing).sort((a, b) => a.sPx - b.sPx);
  const findings = [...alignment.findings];

  // 非单调标尺：迁移距离增大时分子量必须严格减小，否则语义无解
  let nonMonotonic = false;
  for (let i = 1; i < present.length; i += 1) {
    if (!(present[i].sPx > present[i - 1].sPx) || !(present[i].nominalMw < present[i - 1].nominalMw)) {
      nonMonotonic = true;
    }
  }
  if (nonMonotonic) {
    findings.push({
      code: 'NON_MONOTONIC_RULER',
      severity: 'error',
      message: '标尺非单调：同一迁移距离无法唯一决定分子量，该泳道分子量推断语义无解',
      subject: { kind: 'ruler', id: 'ruler', ordinal: ladder.laneOrdinal },
      data: { knots: present.map((k) => ({ ordinal: k.ordinal, sPx: k.sPx, mw: k.nominalMw })) }
    });
  }

  const fit = fitLogLinear(knots);
  const residuals = present.map((k) => ({
    ordinal: k.ordinal,
    residualLogMw: round2(Math.log10(k.nominalMw) - (fit.intercept + fit.slope * k.sPx))
  }));

  const segments: RulerSegment[] = [];
  for (let i = 1; i < present.length; i += 1) {
    const from = present[i - 1];
    const to = present[i];
    segments.push({
      id: contentId('seg', { from: from.ordinal, to: to.ordinal, sFrom: from.sPx, sTo: to.sPx }),
      fromOrdinal: from.ordinal,
      toOrdinal: to.ordinal,
      sMinPx: from.sPx,
      sMaxPx: to.sPx
    });
  }

  const sMin = present.length ? present[0].sPx : 0;
  const sMax = present.length ? present[present.length - 1].sPx : 0;
  const validRange = {
    minPx: round2(Math.max(0, sMin - params.extrapolationMarginPx)),
    maxPx: round2(sMax + params.extrapolationMarginPx)
  };
  findings.push({
    code: 'LOCAL_VALID_RANGE',
    severity: 'info',
    message: '局部标尺有效区域：泳道弯曲时同一像素高度不等于同一分子量，估值只在该弧长区间内有效',
    subject: { kind: 'ruler', id: 'ruler', ordinal: ladder.laneOrdinal },
    validRange
  });

  return {
    kind: 'ruler-calibration',
    laneOrdinal: ladder.laneOrdinal,
    model: params.model,
    knots,
    segments,
    validRange,
    residuals,
    nonMonotonic,
    findings
  };
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

/**
 * 分子量推断（每个样本泳道调用）。
 *  - “微笑”弯曲泳道的 s 是沿脊线弧长，标尺按 ladder 泳道自身弧长建立，
 *    因此同一像素高度（y）在不同泳道的 s 不同，估值必须落在该标尺的有效区域内；
 *  - 饱和 / 拖尾 / 重叠：不出唯一数，只给区间（半高宽边界映射）并保留全部合法候选；
 *  - 非单调标尺：语义无解；有效区域外：out-of-range，不用外推值伪装成功。
 */
export function estimateMolecularWeights(
  calibration: RulerCalibrationResult,
  candidates: BandCandidate[],
  params: CalibrationParams
): { estimates: MwEstimate[]; findings: Finding[] } {
  const findings: Finding[] = [];
  if (calibration.nonMonotonic) {
    findings.push({
      code: 'MW_BLOCKED_NON_MONOTONIC',
      severity: 'error',
      message: '标尺非单调，分子量推断被阻断（语义无解），不产生估值',
      subject: { kind: 'ruler', id: 'ruler' }
    });
    return { estimates: [], findings };
  }
  const present = calibration.knots.filter((k) => !k.missing).sort((a, b) => a.sPx - b.sPx);
  if (present.length < 2) {
    findings.push({
      code: 'MW_BLOCKED_INSUFFICIENT_KNOTS',
      severity: 'error',
      message: '可用 ladder knot 不足 2 个，无法建立标尺',
      subject: { kind: 'ruler', id: 'ruler' }
    });
    return { estimates: [], findings };
  }
  const fit = fitLogLinear(calibration.knots);
  const unit = present[0].unit;

  const mwAt = (s: number): number => 10 ** (fit.intercept + fit.slope * s);

  const bracketAt = (s: number): MwEstimate['bracket'] => {
    if (params.model === 'piecewise-linear') {
      const segment = calibration.segments.find((seg) => s >= seg.sMinPx && s <= seg.sMaxPx);
      if (segment) return { fromOrdinal: segment.fromOrdinal, toOrdinal: segment.toOrdinal, segmentId: segment.id };
    }
    let before = present[0];
    let after = present[present.length - 1];
    for (let i = 1; i < present.length; i += 1) {
      if (s <= present[i].sPx) {
        before = present[i - 1];
        after = present[i];
        break;
      }
      before = present[i];
      after = present[Math.min(i + 1, present.length - 1)];
    }
    const segment = calibration.segments.find(
      (seg) => seg.fromOrdinal === before.ordinal && seg.toOrdinal === after.ordinal
    );
    return { fromOrdinal: before.ordinal, toOrdinal: after.ordinal, segmentId: segment?.id ?? 'extrapolated' };
  };

  const estimates: MwEstimate[] = candidates.map((candidate) => {
    const inRange =
      candidate.sPx >= calibration.validRange.minPx && candidate.sPx <= calibration.validRange.maxPx;
    const soft = candidate.saturated || candidate.tailing || candidate.overlapGroup !== null;
    const bracket = bracketAt(candidate.sPx);

    if (!inRange) {
      findings.push({
        code: 'OUT_OF_VALID_RANGE',
        severity: 'warning',
        message: '条带位于局部标尺有效区域之外，不做外推估值',
        subject: { kind: 'band', id: candidate.id, ordinal: candidate.laneOrdinal },
        at: { x: candidate.centerX, y: candidate.centerY },
        validRange: calibration.validRange
      });
      return {
        candidateId: candidate.id,
        laneOrdinal: candidate.laneOrdinal,
        mw: null,
        interval: null,
        sPx: candidate.sPx,
        bracket: null,
        withinValidRange: false,
        status: 'out-of-range'
      };
    }

    const sLow = Math.max(calibration.validRange.minPx, candidate.sHalfLowPx);
    const sHigh = Math.min(calibration.validRange.maxPx, candidate.sHalfHighPx);
    if (soft) {
      const [a, b] = [mwAt(sHigh), mwAt(sLow)].sort((x, y) => x - y);
      findings.push({
        code: candidate.overlapGroup ? 'MW_INTERVAL_OVERLAP' : candidate.saturated ? 'MW_INTERVAL_SATURATION' : 'MW_INTERVAL_TAILING',
        severity: 'warning',
        message: candidate.overlapGroup
          ? '重叠条带：保留区间与组内全部候选，不给唯一分子量'
          : candidate.saturated
            ? '饱和条带：强度证据失效，只给分子量区间'
            : '拖尾条带：只能给分子量区间',
        subject: { kind: 'band', id: candidate.id, ordinal: candidate.laneOrdinal },
        at: { x: candidate.centerX, y: candidate.centerY },
        validRange: calibration.validRange,
        data: { overlapGroup: candidate.overlapGroup }
      });
      return {
        candidateId: candidate.id,
        laneOrdinal: candidate.laneOrdinal,
        mw: null,
        interval: {
          low: { value: round2(a), unit },
          high: { value: round2(b), unit }
        },
        sPx: candidate.sPx,
        bracket,
        withinValidRange: true,
        status: 'interval'
      };
    }

    return {
      candidateId: candidate.id,
      laneOrdinal: candidate.laneOrdinal,
      mw: { value: round2(mwAt(candidate.sPx)), unit },
      interval: null,
      sPx: candidate.sPx,
      bracket,
      withinValidRange: true,
      status: 'candidate'
    };
  });

  return { estimates, findings };
}

/** piecewise-linear（log10 mw 在相邻 knot 间线性）求值 */
export function piecewiseMwAt(calibration: RulerCalibrationResult, s: number): number | null {
  const present = calibration.knots.filter((k) => !k.missing).sort((a, b) => a.sPx - b.sPx);
  for (let i = 1; i < present.length; i += 1) {
    const a = present[i - 1];
    const b = present[i];
    if (s >= a.sPx && s <= b.sPx) {
      const t = (s - a.sPx) / (b.sPx - a.sPx || 1);
      const logMw = Math.log10(a.nominalMw) + t * (Math.log10(b.nominalMw) - Math.log10(a.nominalMw));
      return 10 ** logMw;
    }
  }
  return null;
}
