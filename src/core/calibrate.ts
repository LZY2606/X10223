import type {
  BandObservation,
  CalibParamsV1,
  CalibSegment,
  ComputeBudget,
  Diagnostic,
  LadderCalibration,
  LadderLaneMaterial,
  LaneMaterial,
} from '../shared/types.ts';
import { projectToPolyline } from '../shared/util.ts';

export interface ArcBand {
  band: BandObservation;
  arcS: number;
}

/** 条带 -> 沿 lane 弧长（微笑弯曲：同 y 不等于同 s） */
export function bandsOnArc(lane: LaneMaterial, bands: BandObservation[]): ArcBand[] {
  return bands
    .filter((b) => b.laneId === lane.id)
    .map((band) => ({
      band,
      arcS: band.arcS.unit === 'lane-arc-px'
        ? band.arcS.value
        : projectToPolyline(band.center.x, band.center.y, lane.centerline).s,
    }))
    .sort((a, b) => a.arcS - b.arcS);
}

export interface Matching {
  /** rung ordinal -> arc band index（保序、可缺 rung、可跳 band） */
  pairs: Array<{ rungOrdinal: number; bandIndex: number }>;
  score: number;
  residual: number;
}

export class BudgetExhaustedError extends Error {
  constructor(public used: number, public budget: number) {
    super('ladder matching enumeration budget exhausted');
    this.name = 'BudgetExhaustedError';
  }
}

/**
 * 枚举保序对齐：nominal rungs（按 s 升序 = 分子量降序）与检测条带。
 * 允许缺带（rung 无对应 band）与杂带（band 无 rung），按对数线性残差打分。
 * 枚举数量受 budget.maxMatchings 硬限制，耗尽 -> 与格式/语义错误不同的结果。
 */
export function enumerateMatchings(
  rungs: LadderLaneMaterial['nominals'],
  arcBands: ArcBand[],
  budget: ComputeBudget,
): { matchings: Matching[]; exhausted: boolean; used: number } {
  const rs = [...rungs].sort((a, b) => a.ordinal - b.ordinal);
  let used = 0;
  let exhausted = false;
  const out: Matching[] = [];

  const visit = (ri: number, bi: number, pairs: Matching['pairs']) => {
    if (used >= budget.maxMatchings) {
      exhausted = true;
      return;
    }
    if (ri >= rs.length || bi >= arcBands.length) {
      if (pairs.length >= 2) {
        used++;
        const m = scoreMatching(rs, pairs, arcBands);
        out.push(m);
      }
      return;
    }
    // 跳过该 band（杂带）
    visit(ri, bi + 1, pairs);
    if (exhausted) return;
    // 跳过该 rung（缺带）
    visit(ri + 1, bi, pairs);
    if (exhausted) return;
    // 配对：s 必须严格递增（非单调对齐在此被剪枝）
    const last = pairs[pairs.length - 1];
    if (!last || arcBands[bi].arcS > arcBands[last.bandIndex].arcS + 0.5) {
      visit(ri + 1, bi + 1, [...pairs, { rungOrdinal: rs[ri].ordinal, bandIndex: bi }]);
    }
  };
  visit(0, 0, []);
  return { matchings: out, exhausted, used };
}

function scoreMatching(
  rungs: LadderLaneMaterial['nominals'],
  pairs: Matching['pairs'],
  arcBands: ArcBand[],
): Matching {
  const xs: number[] = [];
  const ys: number[] = [];
  for (const p of pairs) {
    const rung = rungs.find((r) => r.ordinal === p.rungOrdinal)!;
    xs.push(arcBands[p.bandIndex].arcS);
    ys.push(Math.log(rung.mw.value));
  }
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const slope = sxy / (sxx || 1e-9);
  const intercept = my - slope * mx;
  let se = 0;
  for (let i = 0; i < n; i++) {
    se += (ys[i] - (slope * xs[i] + intercept)) ** 2;
  }
  const residual = Math.sqrt(se / n);
  // 配对多优先，其次残差小；确定性 tie-break
  return {
    pairs,
    residual,
    score: pairs.length * 1000 - residual * 10 - Math.abs(slope) * 1e-6,
  };
}

/** 由对齐构造局部标尺段；非单调（sA>=sB 或 logMwA<=logMwB）的段标无效 */
export function segmentsForMatching(
  rungs: LadderLaneMaterial['nominals'],
  arcBands: ArcBand[],
  matching: Matching,
): { segments: CalibSegment[]; assignments: LadderCalibration['rungAssignments']; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const rs = [...rungs].sort((a, b) => a.ordinal - b.ordinal);
  const assignments: LadderCalibration['rungAssignments'] = matching.pairs
    .map((p) => {
      const rung = rs.find((r) => r.ordinal === p.rungOrdinal)!;
      const ab = arcBands[p.bandIndex];
      return {
        rungId: rung.rungId,
        ordinal: rung.ordinal,
        nominalMw: rung.mw.value,
        bandId: ab.band.id,
        arcS: ab.arcS,
      };
    })
    .sort((a, b) => a.arcS - b.arcS);

  const presentOrdinals = new Set(assignments.map((a) => a.ordinal));
  for (const rung of rs) {
    if (!presentOrdinals.has(rung.ordinal)) {
      diagnostics.push({
        code: 'missing-ladder-rung',
        severity: 'warning',
        at: { rungId: rung.rungId },
        message: `ladder 缺带：标称 ${rung.mw.raw ?? rung.mw.value + 'bp'} 无对应条带`,
      });
    }
  }

  const segments: CalibSegment[] = [];
  for (let i = 0; i < assignments.length - 1; i++) {
    const a = assignments[i];
    const b = assignments[i + 1];
    const sA = a.arcS;
    const sB = b.arcS;
    const logMwA = Math.log(a.nominalMw);
    const logMwB = Math.log(b.nominalMw);
    const expectedOrdinals = b.ordinal - a.ordinal - 1;
    const gap = expectedOrdinals > 0;
    // 逐点内插残差恒为 0（两点定线）；用全局线性偏差作为段残差证据
    const residual = 0;
    const monotoneS = sB > sA;
    const monotoneMw = logMwA > logMwB;
    const valid = monotoneS && monotoneMw;
    if (!valid) {
      diagnostics.push({
        code: 'non-monotonic-scale',
        severity: 'error',
        at: { segmentIndex: i },
        message: `非单调标尺：段 ${a.rungId}->${b.rungId}（s ${sA.toFixed(1)}->${sB.toFixed(1)}，MW ${a.nominalMw}->${b.nominalMw}bp）`,
      });
    }
    if (gap) {
      diagnostics.push({
        code: 'gap-crossing',
        severity: 'warning',
        at: { segmentIndex: i },
        message: `跨缺带区间 ${a.rungId}->${b.rungId}，MW 区间放宽`,
      });
    }
    segments.push({
      index: i,
      rungAId: a.rungId,
      rungBId: b.rungId,
      sA,
      sB,
      logMwA,
      logMwB,
      valid,
      gap,
      residual,
    });
  }
  return { segments, assignments, diagnostics };
}

export function inferMwOnSegment(seg: CalibSegment, s: number): number {
  const u = (s - seg.sA) / (seg.sB - seg.sA);
  const logMw = seg.logMwA + u * (seg.logMwB - seg.logMwA);
  return Math.exp(logMw);
}

export interface CalibrationOutcome {
  calibration: LadderCalibration;
  /** 每个 arc band 在全部合法对齐下的候选 MW（无法唯一决定时全部保留） */
  bandCandidates: Map<string, number[]>;
  /** 主对齐的段（用于点击回溯），与 calibration.segments 相同 */
  exhausted: boolean;
}

/**
 * 完整 ladder 校准：
 * - 最优对齐为主标尺；同分对齐暴露为候选 MW（ambiguous-match）
 * - 非单调段无效，落在其上的条带不给唯一值
 * - 有效区域 = [min s, max s]，禁止外推
 */
export function calibrateLadder(
  lane: LaneMaterial,
  ladder: LadderLaneMaterial,
  bands: BandObservation[],
  params: CalibParamsV1,
  budget: ComputeBudget,
): CalibrationOutcome {
  const arcBands = bandsOnArc(lane, bands);
  const { matchings, exhausted } = enumerateMatchings(ladder.nominals, arcBands, budget);
  const diagnostics: Diagnostic[] = [];
  if (matchings.length === 0) {
    return {
      calibration: {
        laneId: lane.id,
        segments: [],
        validS: [0, 0],
        rungAssignments: [],
        diagnostics: [
          {
            code: 'incomplete-input',
            severity: 'error',
            message: 'ladder 可配对条带不足 2 个，无法建立任何标尺段',
          },
        ],
      },
      bandCandidates: new Map(),
      exhausted,
    };
  }
  const ranked = [...matchings].sort((a, b) => b.score - a.score || a.residual - b.residual);
  const primary = ranked[0];
  const built = segmentsForMatching(ladder.nominals, arcBands, primary);
  diagnostics.push(...built.diagnostics);

  // 近似同分（残差差异 <= 5% 或 <= 0.02 log）视为歧义，全部合法候选保留
  const alternatives = ranked.filter(
    (m) =>
      m !== primary &&
      (Math.abs(m.residual - primary.residual) <= Math.max(0.02, primary.residual * 0.05)),
  );
  if (alternatives.length > 0) {
    diagnostics.push({
      code: 'ambiguous-match',
      severity: 'warning',
      message: `${alternatives.length} 个同等合法的 ladder 对齐，相关条带保留全部候选 MW`,
    });
  }

  const bandCandidates = new Map<string, number[]>();
  const collect = (matching: Matching) => {
    const { segments, assignments } = segmentsForMatching(ladder.nominals, arcBands, matching);
    for (const ab of arcBands) {
      const seg = segmentAt(segments, ab.arcS, params);
      if (!seg || !seg.valid) continue;
      const mw = inferMwOnSegment(seg, ab.arcS);
      const list = bandCandidates.get(ab.band.id) ?? [];
      list.push(mw);
      bandCandidates.set(ab.band.id, list);
    }
    void assignments;
  };
  collect(primary);
  for (const alt of alternatives.slice(0, 7)) collect(alt);
  for (const [, list] of bandCandidates) {
    list.sort((a, b) => a - b);
  }

  const validSSet = built.segments.filter((s) => s.valid);
  const validS: [number, number] = validSSet.length
    ? [validSSet[0].sA, validSSet[validSSet.length - 1].sB]
    : [0, 0];

  return {
    calibration: {
      laneId: lane.id,
      segments: built.segments,
      validS,
      rungAssignments: built.assignments,
      diagnostics,
    },
    bandCandidates,
    exhausted,
  };
}

export function segmentAt(
  segments: CalibSegment[],
  s: number,
  params: CalibParamsV1,
): CalibSegment | null {
  for (const seg of segments) {
    if (s >= seg.sA - params.extrapolationMargin && s <= seg.sB + params.extrapolationMargin) {
      return seg;
    }
  }
  return null;
}

/**
 * 条带 MW 推断（含饱和/拖尾/重叠的证据规则）：
 * - flag != normal：绝不给唯一自动值；标候选或区间
 * - 落在非单调/有效区域外：null + 诊断；有候选则保留
 * - gap 段：区间放宽（默认 ±12%）
 */
export function inferBandMw(
  arcS: number,
  segments: CalibSegment[],
  params: CalibParamsV1,
  candidates: number[],
  flag: BandObservation['flag'],
): {
  autoMw: number | null;
  interval: [number, number] | null;
  segmentIndex: number | null;
  diagnostics: Diagnostic[];
} {
  const diagnostics: Diagnostic[] = [];
  const seg = segmentAt(segments, arcS, params);
  const restricted = flag !== 'normal';
  if (restricted) {
    const code =
      flag === 'saturated' ? 'saturated-band' : flag === 'tailing' ? 'tailing-band' : 'overlapping-bands';
    diagnostics.push({
      code,
      severity: 'warning',
      at: { arcS: Math.round(arcS * 100) / 100 },
      message:
        flag === 'saturated'
          ? '饱和条带：峰顶削平，弧长位置不可信，只能候选/区间'
          : flag === 'tailing'
            ? '拖尾条带：质心偏移，只能候选/区间'
            : '重叠条带：多个峰未分辨，保留簇内全部候选',
    });
  }
  if (!seg) {
    diagnostics.push({
      code: 'outside-valid-region',
      severity: 'error',
      at: { arcS: Math.round(arcS * 100) / 100 },
      message: `s=${arcS.toFixed(1)} 超出局部标尺有效区域，禁止外推`,
    });
    const interval = candidates.length
      ? ([candidates[0], candidates[candidates.length - 1]] as [number, number])
      : null;
    return { autoMw: null, interval, segmentIndex: null, diagnostics };
  }
  if (!seg.valid) {
    diagnostics.push({
      code: 'non-monotonic-scale',
      severity: 'error',
      at: { segmentIndex: seg.index, arcS: Math.round(arcS * 100) / 100 },
      message: `落在非单调段 #${seg.index}，该局部标尺无效`,
    });
    const interval = candidates.length
      ? ([candidates[0], candidates[candidates.length - 1]] as [number, number])
      : null;
    return { autoMw: null, interval, segmentIndex: seg.index, diagnostics };
  }
  const point = inferMwOnSegment(seg, arcS);
  if (candidates.length === 0) candidates = [point];
  const dedup = [...new Set(candidates.map((v) => Math.round(v * 100) / 100))].sort((a, b) => a - b);
  if (seg.gap) {
    diagnostics.push({
      code: 'gap-crossing',
      severity: 'warning',
      at: { segmentIndex: seg.index, arcS },
      message: '该值跨 ladder 缺带内插，区间放宽 ±12%',
    });
    return {
      autoMw: restricted ? null : point,
      interval: [point * 0.88, point * 1.12],
      segmentIndex: seg.index,
      diagnostics,
    };
  }
  if (restricted || dedup.length > 1) {
    if (dedup.length > 1) {
      diagnostics.push({
        code: 'ambiguous-match',
        severity: 'warning',
        at: { segmentIndex: seg.index, arcS },
        message: `${dedup.length} 个合法候选 MW，全部保留`,
      });
    }
    return {
      autoMw: null,
      interval: [dedup[0], dedup[dedup.length - 1]],
      segmentIndex: seg.index,
      diagnostics,
    };
  }
  return { autoMw: point, interval: null, segmentIndex: seg.index, diagnostics };
}
