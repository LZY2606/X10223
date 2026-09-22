import type { CalibrationSegment, Diagnostic, LadderNominalEntry, Quantity } from '../shared/types';
import type { DetectedBand } from './bands';
import { GelFailure, diag } from './errors';
import { PARAM_VERSIONS, DEFAULT_PARAMS } from './params';

export interface AssignedLadderBand {
  band: DetectedBand;
  entry: LadderNominalEntry;
  residualPx: number;
  alternatives?: { entryId: string; residualPx: number }[];
}

/**
 * ladder 匹配：DP 单调对齐（允许跳过缺带，代价 = 残差² + 缺带惩罚）。
 * 非单调：允许显式 assignments（非单调标尺案例），随后按物理方向校验斜率。
 */
export function assignLadder(
  observed: DetectedBand[],
  entries: LadderNominalEntry[],
  explicit?: { bandIndex: number; entryId: string }[]
): { assigned: AssignedLadderBand[]; diagnostics: Diagnostic[] } {
  for (const e of entries) {
    if (!e.nominal.convertible || e.nominal.value === undefined) {
      throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
        diag(
          'SEMANTIC_UNRESOLVABLE',
          'error',
          `ladder 标称 ${e.nominal.rawText} 无法规范化为数值单位，不能用于校准`,
          { ladderEntryId: e.entryId }
        ),
      ]);
    }
  }
  const obs = [...observed].sort((a, b) => a.tArcPx - b.tArcPx);
  const nom = [...entries].sort((a, b) => a.ordinal - b.ordinal);

  if (explicit) {
    const diagnostics: Diagnostic[] = [];
    const assigned: AssignedLadderBand[] = [];
    for (const a of explicit) {
      const band = obs[a.bandIndex];
      const entry = entries.find((e) => e.entryId === a.entryId);
      if (!band || !entry) {
        throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
          diag('INCOMPLETE_INPUT', 'error', '显式 ladder 分配引用了不存在的条带或标称', {
            ladderEntryId: a.entryId,
          }),
        ]);
      }
      assigned.push({ band, entry, residualPx: 0 });
    }
    assigned.sort((a, b) => a.band.tArcPx - b.band.tArcPx);
    return { assigned, diagnostics };
  }

  const skipPenalty = DEFAULT_PARAMS[PARAM_VERSIONS.calibration].values.missingSkipPenalty as number;
  // 先按 log-linear 全局趋势预测每个标称的 t，残差小则匹配可计算
  const logNoms = nom.map((n) => Math.log10(n.nominal.value!));
  const n = obs.length;
  const m = nom.length;
  if (n === 0) {
    throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
      diag('LADDER_BAND_MISSING', 'error', 'ladder 泳道未检测到任何条带，无法建立标尺', {}),
    ]);
  }
  // 以首/末观测做初猜
  const t0 = obs[0].tArcPx;
  const t1 = obs[n - 1].tArcPx;
  const l0 = logNoms[0];
  const l1 = logNoms[logNoms.length - 1];
  const predictT = (li: number) =>
    logNoms.length === 1 ? t0 : t0 + ((l0 - li) / (l0 - l1)) * (t1 - t0);

  // DP: dp[i][j] = 前 i 观测匹配到第 j 标称（含跳过）的最小代价
  const INF = 1e18;
  const dp: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(INF));
  const back: ([number, number] | null)[][] = Array.from({ length: n + 1 }, () =>
    new Array(m + 1).fill(null)
  );
  dp[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (dp[i][j] === INF) continue;
      if (i < n) {
        // 跳过该观测（杂带）
        const v = dp[i][j] + skipPenalty;
        if (v < dp[i + 1][j]) {
          dp[i + 1][j] = v;
          back[i + 1][j] = [i, j];
        }
      }
      if (i < n && j < m) {
        const residual = obs[i].tArcPx - predictT(logNoms[j]);
        const v = dp[i][j] + residual * residual;
        if (v < dp[i + 1][j + 1]) {
          dp[i + 1][j + 1] = v;
          back[i + 1][j + 1] = [i, j];
        }
      }
      if (j < m) {
        // 缺带：标称被跳过
        const v = dp[i][j] + skipPenalty;
        if (v < dp[i][j + 1]) {
          dp[i][j + 1] = v;
          back[i][j + 1] = [i, j];
        }
      }
    }
  }

  const pairs: { oi: number; nj: number }[] = [];
  let i = n;
  let j = m;
  while (i > 0 || j > 0) {
    const prev = back[i][j];
    if (!prev) break;
    const [pi, pj] = prev;
    if (pi === i - 1 && pj === j - 1) pairs.push({ oi: i - 1, nj: j - 1 });
    i = pi;
    j = pj;
  }
  pairs.reverse();

  const assigned: AssignedLadderBand[] = pairs.map(({ oi, nj }) => {
    const residual = obs[oi].tArcPx - predictT(logNoms[nj]);
    return { band: obs[oi], entry: nom[nj], residualPx: residual };
  });

  const diagnostics: Diagnostic[] = [];
  const matchedNoms = new Set(pairs.map((p) => p.nj));
  for (let k = 0; k < nom.length; k++) {
    if (!matchedNoms.has(k)) {
      diagnostics.push(
        diag(
          'LADDER_BAND_MISSING',
          'warning',
          `ladder 标称 ${nom[k].nominal.rawText}（${nom[k].entryId}）未找到匹配带，按缺带处理；相邻插值段保留但标注跨缺带`,
          { ladderEntryId: nom[k].entryId }
        )
      );
    }
  }
  return { assigned, diagnostics };
}

/** 局部 log-linear 拟合；物理上 log(MW) 必须随 t 增大而减小，否则该段非单调失效 */
export function fitSegments(
  laneId: string,
  assigned: AssignedLadderBand[]
): { segments: CalibrationSegment[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const segments: CalibrationSegment[] = [];
  const sorted = [...assigned].sort((a, b) => a.band.tArcPx - b.band.tArcPx);
  for (let k = 0; k < sorted.length - 1; k++) {
    const lo = sorted[k];
    const hi = sorted[k + 1];
    const tLo = lo.band.tArcPx;
    const tHi = hi.band.tArcPx;
    const logLo = Math.log10(lo.entry.nominal.value!);
    const logHi = Math.log10(hi.entry.nominal.value!);
    const slope = (logHi - logLo) / ((tHi - tLo) || 1e-9);
    const intercept = logLo - slope * tLo;
    const valid = slope < 0;
    const segmentId = `seg-${laneId}-${lo.entry.entryId}-${hi.entry.entryId}`;
    if (!valid) {
      diagnostics.push(
        diag(
          'NON_MONOTONIC_LADDER',
          'error',
          `插值段 ${lo.entry.nominal.rawText}→${hi.entry.nominal.rawText} 斜率为正（${slope.toExponential(2)}/px），标尺非单调，此段判为语义无解`,
          { segmentId, laneId, tArc: (tLo + tHi) / 2 }
        )
      );
    }
    const midResidual =
      Math.abs(Math.log10(lo.entry.nominal.value!) - (slope * tLo + intercept)) +
      Math.abs(Math.log10(hi.entry.nominal.value!) - (slope * tHi + intercept));
    segments.push({
      segmentId,
      lowEntryId: lo.entry.entryId,
      highEntryId: hi.entry.entryId,
      slopePerPx: slope,
      intercept,
      tLowPx: tLo,
      tHighPx: tHi,
      fitResidualPx: midResidual,
      laneId,
      valid,
      invalidReason: valid ? undefined : 'NON_MONOTONIC_LADDER',
    });
  }
  return { segments, diagnostics };
}

export interface InferenceResult {
  quantity: Quantity;
  status: 'candidate' | 'interval' | 'ambiguous';
  segmentId: string;
  tMinPx: number;
  tMaxPx: number;
  ladderEntryIds: string[];
  fitResidualPx: number;
  interval?: { low: number; high: number; unit: string };
  diagnostics: Diagnostic[];
}

/**
 * 分子量推断：局部插值段 + 有效区域。
 * - 段外：不静默外推，状态 ambiguous 并给 OUTSIDE_VALID_REGION
 * - 非单调段：ambiguous
 * - 饱和/拖尾/重叠：区间或候选，绝不给唯一接受值
 */
export function inferMw(
  band: DetectedBand,
  segments: CalibrationSegment[],
  entryById: Map<string, LadderNominalEntry>,
  uncertainty: { saturated: boolean; tailing: boolean; overlapping: boolean }
): InferenceResult {
  const t = band.tArcPx;
  const seg = segments.find((s) => t >= s.tLowPx - 1e-6 && t <= s.tHighPx + 1e-6 && s.valid);
  const diagnostics: Diagnostic[] = [];
  if (!seg) {
    const invalidSeg = segments.find((s) => t >= s.tLowPx - 1e-6 && t <= s.tHighPx + 1e-6 && !s.valid);
    if (invalidSeg) {
      diagnostics.push(
        diag(
          'NON_MONOTONIC_LADDER',
          'error',
          `条带落在非单调插值段 ${invalidSeg.segmentId} 内，分子量无唯一合法解，保留歧义状态`,
          { segmentId: invalidSeg.segmentId, tArc: t }
        )
      );
    } else {
      diagnostics.push(
        diag(
          'OUTSIDE_VALID_REGION',
          'warning',
          `条带 t=${t.toFixed(1)}px 位于所有有效插值段之外，不外推；需要新 ladder 锚点`,
          { tArc: t }
        )
      );
    }
    return {
      quantity: { rawText: 'N/A', convertible: false },
      status: 'ambiguous',
      segmentId: invalidSeg?.segmentId ?? 'none',
      tMinPx: NaN,
      tMaxPx: NaN,
      ladderEntryIds: [],
      fitResidualPx: NaN,
      diagnostics,
    };
  }

  const unit = entryById.get(seg.lowEntryId)?.nominal.unit ?? 'bp';
  const logMw = seg.slopePerPx * t + seg.intercept;
  const mw = Math.pow(10, logMw);
  const rawText = `${mw.toFixed(1)} ${unit}`;

  // 局部不确定度：饱和/拖尾/重叠与峰宽共同决定区间
  const widthFactor = Math.min(0.25, Math.abs(seg.slopePerPx) * band.widthPx * 1.5);
  let frac = widthFactor;
  if (uncertainty.saturated) frac += 0.12;
  if (uncertainty.tailing) frac += 0.1;
  if (uncertainty.overlapping) frac += 0.15;
  const ambiguous = uncertainty.saturated || uncertainty.tailing || uncertainty.overlapping;

  const quantity: Quantity = { rawText, value: mw, unit, convertible: true };
  const result: InferenceResult = {
    quantity,
    status: ambiguous ? 'interval' : 'candidate',
    segmentId: seg.segmentId,
    tMinPx: seg.tLowPx,
    tMaxPx: seg.tHighPx,
    ladderEntryIds: [seg.lowEntryId, seg.highEntryId],
    fitResidualPx: seg.fitResidualPx,
    diagnostics,
  };
  if (ambiguous) {
    const low = mw * Math.pow(10, -frac);
    const high = mw * Math.pow(10, frac);
    result.interval = { low, high, unit };
    result.quantity.rawText = `${low.toFixed(1)}–${high.toFixed(1)} ${unit}（区间，中心 ${mw.toFixed(1)}）`;
    diagnostics.push(
      diag(
        uncertainty.overlapping ? 'OVERLAPPING_BANDS' : uncertainty.saturated ? 'SATURATED_BAND' : 'TAILING_BAND',
        'warning',
        `条带证据不唯一，分子量只能给区间 [${low.toFixed(1)}, ${high.toFixed(1)}] ${unit}`,
        { tArc: t, segmentId: seg.segmentId }
      )
    );
  }
  return result;
}
