import type {
  CalibrationResult,
  CalibrationSegment,
  Diagnostic,
  LadderSpecMaterial,
  LadderMappingPoint,
  LaneAnnotationMaterial,
  PixelPoint,
  QuantitativeValue,
} from './types.js';
import type { DetectionResult, DetectedBand } from './types.js';
import { arcTable, pointAtArcLength, projectToPolyline } from './geometry.js';
import { contentId } from './hash.js';
import type { PipelineParams } from './params.js';
import { semanticError } from './errors.js';

export interface CalibInput {
  frameId: string;
  lanes: LaneAnnotationMaterial;
  ladderSpec: LadderSpecMaterial;
  detection: DetectionResult;
  params: PipelineParams;
}

/**
 * 用 ladder 泳道建立局部标尺。
 * 关键规则：
 *  - 标尺沿“泳道中心线弧长分数 f=s/L”参数化，弯曲泳道同样适用；
 *  - 每相邻两个 ladder 点构成一个插值段，段的有效区域显式记录；
 *  - 缺带：枚举全部保序配对作为合法候选，不能唯一决定时全部保留；
 *  - 标称值非单调：语义无解，直接失败（不产出伪标尺）。
 */
export function calibrate(input: CalibInput): CalibrationResult {
  const { lanes, ladderSpec, detection, params, frameId } = input;
  const ladderLane = lanes.lanes.find((l) => l.laneRef === ladderSpec.ladderLaneRef);
  if (!ladderLane) {
    throw semanticError(`ladder 泳道 ${ladderSpec.ladderLaneRef} 不存在`, [
      { code: 'INCOMPLETE_INPUT', message: 'ladder 泳道缺失', path: '/ladderSpec/ladderLaneRef' },
    ]);
  }

  const diagnostics: Diagnostic[] = [];

  // 非单调检查：标称值必须沿 expectedRank 严格递减（rank 小=分子量大）。
  const entries = [...ladderSpec.entries].sort((a, b) => a.expectedRank - b.expectedRank);
  const values: number[] = [];
  for (const e of entries) {
    if (e.label.value === null) {
      throw semanticError(`ladder 第 ${e.ordinal} 项无法解析：${e.label.rawValue}`, [
        {
          code: 'UNPARSEABLE_VALUE',
          message: `标称值 ${e.label.rawValue} 无法转换`,
          path: `/ladderSpec/entries/${e.ordinal}/label`,
        },
      ]);
    }
    values.push(e.label.value);
  }
  for (let i = 1; i < values.length; i++) {
    if (values[i] >= values[i - 1]) {
      throw semanticError('ladder 标称值非单调，标尺语义无解', [
        {
          code: 'NONMONOTONIC_SCALE',
          message: `第 ${entries[i - 1].ordinal}→${entries[i].ordinal} 项不满足严格递减`,
          path: `/ladderSpec/entries/${entries[i].ordinal}/label`,
        },
      ]);
    }
  }

  const ladderBands = detection.bands
    .filter((b) => b.laneRef === ladderSpec.ladderLaneRef)
    .sort((a, b) => arcS(ladderLane.centerline, a) - arcS(ladderLane.centerline, b));
  if (ladderBands.length === 0) {
    throw semanticError('ladder 泳道未检测到任何条带', [
      { code: 'MISSING_LADDER_BAND', message: 'ladder 泳道无条带', laneRef: ladderSpec.ladderLaneRef },
    ]);
  }

  const table = arcTable(ladderLane.centerline);
  const laneLength = table[table.length - 1].s;

  // 枚举保序配对（entries 中选 bands.length 个的全部子序列）。
  const combos = chooseCombos(entries.length, ladderBands.length);
  if (combos.length === 0) {
    throw semanticError('ladder 条带数多于标称条目，无法配对', [
      { code: 'AMBIGUOUS_MATCH', message: `检测到 ${ladderBands.length} 条带，标称仅 ${entries.length} 项` },
    ]);
  }
  const candidates = combos.map((entryIdx) => {
    const assignment = ladderBands.map((band, k) => ({
      bandRef: band.bandRef,
      entryOrdinal: entries[entryIdx[k]].ordinal,
    }));
    const chosen = entryIdx.map((j) => entries[j]);
    return {
      preferred: false,
      assignment,
      score: assignmentScore(ladderLane.centerline, ladderBands, chosen, laneLength),
    };
  });
  candidates.sort((a, b) => a.score - b.score);
  candidates[0].preferred = true;
  const ambiguous = candidates.length > 1 && candidates[1].score - candidates[0].score < 0.05;
  if (ladderBands.length < entries.length) {
    diagnostics.push({
      code: 'MISSING_LADDER_BAND',
      message: `ladder 缺带：标称 ${entries.length} 条，检出 ${ladderBands.length} 条；保留 ${candidates.length} 个保序候选`,
      laneRef: ladderSpec.ladderLaneRef,
    });
  }
  if (ambiguous) {
    diagnostics.push({
      code: 'AMBIGUOUS_MATCH',
      message: '多个配对拟合质量接近，分子量只能作为候选',
      laneRef: ladderSpec.ladderLaneRef,
    });
  }

  // 微笑检测：固定弧长分数 f 时，各泳道几何 y 的差异过大。
  const smile = smileYSpread(lanes.lanes);
  if (smile.maxDy > 6) {
    diagnostics.push({
      code: 'SMILE_DETECTED',
      message: `“微笑”弯曲：f=${smile.f.toFixed(2)} 处跨泳道 y 差 ${smile.maxDy.toFixed(1)}px；同一像素高度不等于同一分子量，已改用各泳道弧长的局部标尺`,
    });
  }

  const preferred = candidates[0];
  const byOrdinal = new Map(entries.map((e) => [e.ordinal, e]));
  const points: LadderMappingPoint[] = preferred.assignment.map((a) => {
    const band = ladderBands.find((b) => b.bandRef === a.bandRef)!;
    const entry = byOrdinal.get(a.entryOrdinal)!;
    return {
      bandRef: band.bandRef,
      entryOrdinal: entry.ordinal,
      s: arcS(ladderLane.centerline, band),
      center: band.center,
      nominal: entry.label,
      residual: null,
      valid: band.status === 'detected',
    };
  });

  // 全局 log 线性回归仅用于残差展示；推断使用分段插值。
  const fs = points.map((q) => q.s / laneLength);
  const logs = points.map((q) => Math.log10(q.nominal.value as number));
  const fit = linearFit(fs, logs);
  for (const pt of points) {
    const f = pt.s / laneLength;
    const r = Math.log10(pt.nominal.value as number) - (fit.intercept + fit.slope * f);
    pt.residual = Math.round(Math.abs(r) * 1e4) / 1e4;
  }

  const segments: CalibrationSegment[] = [];
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const fA = a.s / laneLength;
    const fB = b.s / laneLength;
    const logA = Math.log10(a.nominal.value as number);
    const logB = Math.log10(b.nominal.value as number);
    segments.push({
      index: i,
      fromEntryOrdinal: a.entryOrdinal,
      toEntryOrdinal: b.entryOrdinal,
      validRange: { sMin: Math.round(a.s * 100) / 100, sMax: Math.round(b.s * 100) / 100, fMin: Math.min(fA, fB), fMax: Math.max(fA, fB) },
      logIntercept: logA - ((logB - logA) / (fB - fA)) * fA,
      logSlope: (logB - logA) / (fB - fA),
      ladderPointIds: [a.bandRef, b.bandRef],
    });
  }

  const base = {
    kind: 'calibration' as const,
    frameId,
    ladderLaneRef: ladderSpec.ladderLaneRef,
    unit: ladderSpec.unit,
    paramsVersion: params.version!,
    parentIds: [lanes.id, ladderSpec.id, detection.id],
    ladderPoints: points,
    segments,
    pairingCandidates: candidates,
    diagnostics,
    inputSummary: {
      lanes: lanes.id,
      ladderSpec: ladderSpec.id,
      detection: detection.id,
      paramsVersion: params.version,
      laneLengthPx: Math.round(laneLength * 10) / 10,
      ladderLaneLengthPx: Math.round(laneLength * 1000) / 1000,
      smileSpreadPx: Math.round(smile.maxDy * 10) / 10,
      preferredAssignmentScore: Math.round(candidates[0].score * 1e5) / 1e5,
      candidateCount: candidates.length,
    },
  };
  return { ...base, id: contentId('cal', base) };
}

export function arcS(centerline: PixelPoint[], band: { center: PixelPoint }): number {
  return projectToPolyline(centerline, band.center).s;
}

/** 从 n 个位置中选 k 个的全部递增下标组合。 */
export function chooseCombos(n: number, k: number): number[][] {
  if (k > n) return [];
  const result: number[][] = [];
  const combo: number[] = [];
  const walk = (start: number) => {
    if (combo.length === k) {
      result.push([...combo]);
      return;
    }
    for (let i = start; i < n; i++) {
      combo.push(i);
      walk(i + 1);
      combo.pop();
    }
  };
  walk(0);
  return result;
}

/** 配对评分：对 (fraction, log MW) 做线性拟合，返回归一化残差平方和。 */
function assignmentScore(
  centerline: PixelPoint[],
  bands: DetectedBand[],
  chosen: QuantitativeValue[],
  laneLength: number,
): number {
  const pts = bands.map((b, i) => ({
    f: arcS(centerline, b) / laneLength,
    y: Math.log10(chosen[i].value as number),
  }));
  const fit = linearFit(
    pts.map((p) => p.f),
    pts.map((p) => p.y),
  );
  let ss = 0;
  for (const p of pts) ss += (p.y - (fit.intercept + fit.slope * p.f)) ** 2;
  return ss / Math.max(1, pts.length);
}

function linearFit(xs: number[], ys: number[]): { intercept: number; slope: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let num = 0;
  let den = 0;
  for (let i = 0; i < n; i++) {
    num += (xs[i] - mx) * (ys[i] - my);
    den += (xs[i] - mx) ** 2;
  }
  const slope = den === 0 ? 0 : num / den;
  return { intercept: my - slope * mx, slope };
}

/** 在多个完整泳道的相同 f 处采样几何 y，返回最大极差（微笑程度）。 */
function smileYSpread(lanes: LaneAnnotationMaterial['lanes']): { f: number; maxDy: number } {
  const full = lanes.filter((l) => l.centerline.length >= 2);
  let worst = { f: 0, maxDy: 0 };
  for (const f of [0.25, 0.5, 0.75]) {
    const ys = full.map((l) => {
      const total = arcTable(l.centerline);
      return pointAtArcLength(l.centerline, total[total.length - 1].s * f).point.y;
    });
    const dy = Math.max(...ys) - Math.min(...ys);
    if (dy > worst.maxDy) worst = { f, maxDy: dy };
  }
  return worst;
}
