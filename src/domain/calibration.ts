import type {
  BandCenterMaterial,
  CalibrationSegment,
  Diagnostic,
  InputSummary,
  LadderNominalMaterial,
  LaneTraceMaterial,
  Qty,
} from './types';
import { derivedId } from './ids';
import { projectionArcLength, polylineLength } from './geometry';
import type { CalcParams } from './params';

/**
 * Ladder 对齐：观测条带（按迁移距离排序）与标称条带（rank，按迁移方向 MW 递减）。
 * - 缺带：枚举全部保持顺序的子序列对齐（受预算上限），残差合格者全部保留为合法候选。
 * - 标称非单调：直接语义无解（SEMANTIC_NO_SOLUTION / NON_MONOTONIC_SCALE）。
 * - 同一高度不等于同一分子量：标尺沿各自弯曲 lane 的弧长建立，局部标尺带有效区域。
 */

export interface LadderAlignment {
  /** observed band id -> nominal rank */
  mapping: { bandId: string; rank: number; s: number; nominalBp: number }[];
  residualRatio: number; // 半对数线性拟合残差（相对量程）
  segments: CalibrationSegment[];
  totalLengthPx: number;
  spanNorm: { min: number; max: number };
}

export interface CalibrationOutput {
  id: string;
  subjectId: string;
  state: 'ok' | 'candidate_set' | 'invalid';
  alignments: LadderAlignment[];
  acceptedAlignmentIndex?: number;
  diagnostics: Diagnostic[];
}

/** 标称值沿迁移方向必须严格递减（rank 增大 -> MW 减小） */
export function checkNominalMonotonic(ladder: LadderNominalMaterial): Diagnostic | null {
  for (let i = 1; i < ladder.bands.length; i++) {
    if (!(ladder.bands[i]!.molecularWeight.value < ladder.bands[i - 1]!.molecularWeight.value)) {
      return {
        code: 'NON_MONOTONIC_SCALE',
        severity: 'error',
        message: `ladder 标称值在 rank ${ladder.bands[i - 1]!.rank}->${ladder.bands[i]!.rank} 非单调，无法建立分子量标尺`,
        location: {
          materialId: ladder.id,
          jsonPath: `bands[${i}].molecularWeight`,
        },
      };
    }
  }
  return null;
}

/** 半对数线性拟合 ln(MW) = a + b*n，返回残差（归一化迁移单位） */
function fitLogLinear(points: { n: number; bp: number }[]): { a: number; b: number; residual: number } {
  const n = points.length;
  const xs = points.map((p) => p.n);
  const ys = points.map((p) => Math.log(p.bp));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i]! - mx) * (ys[i]! - my);
    den += (xs[i]! - mx) ** 2;
  }
  const b = den === 0 ? 0 : num / den;
  const a = my - b * mx;
  let res = 0;
  for (let i = 0; i < n; i++) {
    const pred = a + b * xs[i]!;
    res += (ys[i]! - pred) ** 2;
  }
  return { a, b, residual: Math.sqrt(res / n) };
}

export function calibrateLadder(
  ladder: LadderNominalMaterial,
  lane: LaneTraceMaterial,
  observed: BandCenterMaterial[],
  params: CalcParams,
  inputSummary: InputSummary
): CalibrationOutput {
  const nonMono = checkNominalMonotonic(ladder);
  const recId = derivedId('calibration', {
    ladder: ladder.id,
    lane: lane.id,
    bands: observed.map((b) => b.id).sort(),
    params: params.version,
  });
  if (nonMono) {
    return { id: recId, subjectId: lane.id, state: 'invalid', alignments: [], diagnostics: [nonMono] };
  }
  if (observed.length < 2) {
    return {
      id: recId,
      subjectId: lane.id,
      state: 'invalid',
      alignments: [],
      diagnostics: [
        {
          code: 'INCOMPLETE_INPUT',
          severity: 'error',
          message: 'ladder lane 观测锚点少于 2 个，无法校准',
          location: { laneId: lane.id },
        },
      ],
    };
  }

  const total = polylineLength(lane.centerline);
  const sorted = [...observed]
    .map((b) => ({ band: b, s: projectionArcLength(lane.centerline, b.center).s }))
    .sort((a, b) => a.s - b.s);

  const nominalByRank = new Map(ladder.bands.map((b) => [b.rank, b]));
  const maxRank = ladder.bands.length;

  const diagnostics: Diagnostic[] = [];
  let budgetUsed = 0;
  const alignments: LadderAlignment[] = [];

  const tryAlign = (pairs: { bandId: string; s: number; rank: number }[]) => {
    budgetUsed++;
    if (budgetUsed > params.maxBudget.alignments) return false;
    const points = pairs.map((p) => {
      const nom = nominalByRank.get(p.rank)!;
      return { n: p.s / total, bp: nom.molecularWeight.value };
    });
    const fit = fitLogLinear(points);
    if (fit.residual > params.maxResidualRatio * Math.log(maxRank > 0 ? nominalByRank.get(1)!.molecularWeight.value / nominalByRank.get(maxRank)!.molecularWeight.value : Math.E)) {
      // 残差过大不是合法对齐
      return true;
    }
    const ns = pairs.map((p) => p.s / total);
    const nMin = Math.min(...ns);
    const nMax = Math.max(...ns);
    const segments: CalibrationSegment[] = pairs.map((p) => {
      const nom = nominalByRank.get(p.rank)!;
      return {
        ladderBandId: `${ladder.id}#rank${p.rank}`,
        rank: p.rank,
        migrationPx: round3(p.s),
        normalizedMigration: round6(p.s / total),
        nominal: { ...nom.molecularWeight },
        validRegion: {
          from: round6(Math.max(0, nMin - params.validMargin)),
          to: round6(Math.min(1, nMax + params.validMargin)),
        },
      };
    });
    alignments.push({
      mapping: pairs
        .map((p) => ({ bandId: p.bandId, rank: p.rank, s: round3(p.s), nominalBp: nominalByRank.get(p.rank)!.molecularWeight.value }))
        .sort((a, b) => a.s - b.s),
      residualRatio: round6(fit.residual),
      segments,
      totalLengthPx: round3(total),
      spanNorm: { min: round6(nMin), max: round6(nMax) },
    });
    return true;
  };

  if (sorted.length === ladder.bands.length) {
    // 一一对应
    tryAlign(sorted.map((o, i) => ({ bandId: o.band.id, s: o.s, rank: i + 1 })));
  } else if (sorted.length < ladder.bands.length) {
    // 缺带：枚举保持顺序的 rank 子序列
    diagnostics.push({
      code: 'MISSING_LADDER_BAND',
      severity: 'warning',
      message: `观测到 ${sorted.length} 条 ladder 带，标称 ${ladder.bands.length} 条，保留全部残差合格的合法对齐候选`,
      location: { laneId: lane.id, materialId: ladder.id },
    });
    const k = sorted.length;
    const chosen: number[] = [];
    let exhausted = false;
    const enumRec = (startRank: number, obsIdx: number) => {
      if (exhausted) return;
      if (obsIdx === k) {
        if (alignments.length >= params.maxAlignmentCandidates) {
          exhausted = true;
          return;
        }
        tryAlign(sorted.map((o, i) => ({ bandId: o.band.id, s: o.s, rank: chosen[i]! })));
        return;
      }
      const remainObs = k - obsIdx - 1;
      for (let r = startRank; r <= maxRank - remainObs; r++) {
        chosen[obsIdx] = r;
        enumRec(r + 1, obsIdx + 1);
        if (exhausted) return;
      }
    };
    enumRec(1, 0);
    if (exhausted || budgetUsed > params.maxBudget.alignments) {
      return {
        id: recId,
        subjectId: lane.id,
        state: 'invalid',
        alignments: [],
        diagnostics: [
          {
            code: 'BUDGET_EXHAUSTED',
            severity: 'error',
            message: 'ladder 缺带对齐枚举超过资源预算，未给结论',
            location: { laneId: lane.id },
          },
        ],
      };
    }
  } else {
    return {
      id: recId,
      subjectId: lane.id,
      state: 'invalid',
      alignments: [],
      diagnostics: [
        {
          code: 'SEMANTIC_NO_SOLUTION',
          severity: 'error',
          message: '观测 ladder 带数多于标称带数，无法无歧义对齐',
          location: { laneId: lane.id },
        },
      ],
    };
  }

  if (alignments.length === 0) {
    return {
      id: recId,
      subjectId: lane.id,
      state: 'invalid',
      alignments: [],
      diagnostics: [
        {
          code: 'SEMANTIC_NO_SOLUTION',
          severity: 'error',
          message: '没有残差合格的 ladder 对齐，标尺语义无解',
          location: { laneId: lane.id },
        },
      ],
    };
  }

  // 残差排序：等价输入 -> 稳定顺序（残差相同则按 mapping 身份字典序）
  alignments.sort((a, b) =>
    a.residualRatio === b.residualRatio
      ? JSON.stringify(a.mapping).localeCompare(JSON.stringify(b.mapping))
      : a.residualRatio - b.residualRatio
  );

  return {
    id: recId,
    subjectId: lane.id,
    state: alignments.length > 1 ? 'candidate_set' : 'ok',
    alignments,
    diagnostics,
  };
}

/** 段间半对数插值（bp）。n 必须在有效区域内；每段携带有效区间。 */
export function interpolateBp(alignment: LadderAlignment, n: number): { value: number; segmentRefs: string[]; diagnostics: Diagnostic[] } {
  const segs = alignment.segments;
  const diagnostics: Diagnostic[] = [];
  if (n < segs[0]!.normalizedMigration || n > segs[segs.length - 1]!.normalizedMigration) {
    diagnostics.push({
      code: 'OUT_OF_CALIBRATION_RANGE',
      severity: 'error',
      message: '条带迁移超出 ladder 有效区域，局部标尺不外延',
      location: { at: { x: n, y: 0 } },
    });
    return { value: NaN, segmentRefs: [], diagnostics };
  }
  for (let i = 1; i < segs.length; i++) {
    const lo = segs[i - 1]!;
    const hi = segs[i]!;
    if (n >= lo.normalizedMigration && n <= hi.normalizedMigration) {
      const t = (n - lo.normalizedMigration) / (hi.normalizedMigration - lo.normalizedMigration || 1);
      const bp = Math.exp(Math.log(lo.nominal.value) + t * (Math.log(hi.nominal.value) - Math.log(lo.nominal.value)));
      return { value: bp, segmentRefs: [lo.ladderBandId, hi.ladderBandId], diagnostics };
    }
  }
  diagnostics.push({ code: 'OUT_OF_CALIBRATION_RANGE', severity: 'error', message: '未落入任何插值段' });
  return { value: NaN, segmentRefs: [], diagnostics };
}

function round3(v: number): number {
  return Math.round(v * 1e3) / 1e3;
}
function round6(v: number): number {
  return Math.round(v * 1e6) / 1e6;
}

export type { Qty };
