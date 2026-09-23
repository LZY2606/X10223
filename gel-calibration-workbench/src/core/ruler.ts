import type {
  Diagnostic,
  LadderMark,
  LadderSpec,
  LaneCurveResult,
  MwValue,
  RulerPoint,
  RulerResult,
  ValidRegion,
} from '../shared/types';
import { pixelToArc } from './lanes';

export interface RulerFitOutcome {
  result: RulerResult | null;
  diagnostics: Diagnostic[];
  failureKind: 'SEMANTIC_UNSOLVABLE' | null;
}

// 由 ladder 标记建立局部标尺。标尺只在 [第一个标记, 最后一个标记] 的弧长区间内有效。
export function fitRuler(
  laneCurve: LaneCurveResult,
  marks: LadderMark[],
  ladder: LadderSpec,
): RulerFitOutcome {
  const diagnostics: Diagnostic[] = [];
  const nominal = new Map(ladder.bands.map((b) => [b.id, b]));
  const points: RulerPoint[] = [];

  for (const mark of [...marks].sort((a, b) => a.id.localeCompare(b.id))) {
    const band = nominal.get(mark.ladderBandId);
    if (!band) {
      diagnostics.push({
        code: 'LADDER_MARK_WITHOUT_NOMINAL',
        severity: 'error',
        location: { entity: 'ladderMark', id: mark.id },
        message: `ladder 标记 ${mark.id} 指向不存在的标称条带 ${mark.ladderBandId}`,
      });
      continue;
    }
    if (band.sizeBp === null || !(band.sizeBp > 0)) {
      diagnostics.push({
        code: 'VALUE_UNCONVERTIBLE',
        severity: 'error',
        location: { entity: 'ladderSpec', id: ladder.id, field: `bands.${band.id}` },
        message: `标称值 "${band.raw}" 无法转换为 bp，保留在原位置并跳过`,
      });
      continue;
    }
    const arc = pixelToArc(laneCurve, mark.position);
    if (!arc) {
      diagnostics.push({
        code: 'MARK_OFF_LANE',
        severity: 'error',
        location: { entity: 'ladderMark', id: mark.id, point: mark.position },
        message: `ladder 标记 ${mark.id} 无法投影到泳道中心线`,
      });
      continue;
    }
    points.push({ markId: mark.id, m: arc.s, logBp: Math.log10(band.sizeBp), sizeBp: band.sizeBp });
  }

  // 稳定顺序：按弧长升序，再按 id。
  points.sort((a, b) => a.m - b.m || a.markId.localeCompare(b.markId));

  if (points.length < 2) {
    diagnostics.push({
      code: 'RULER_POINTS_INSUFFICIENT',
      severity: 'error',
      location: { entity: 'lane', id: laneCurve.laneId },
      message: `有效 ladder 点不足（${points.length}），无法建立标尺`,
    });
    return { result: null, diagnostics, failureKind: 'SEMANTIC_UNSOLVABLE' };
  }

  // 单调性：迁移距离越大，分子量必须严格越小；违反即语义无解。
  let nonMonotonic = false;
  for (let i = 1; i < points.length; i++) {
    if (!(points[i].logBp < points[i - 1].logBp)) {
      nonMonotonic = true;
      diagnostics.push({
        code: 'RULER_NON_MONOTONIC',
        severity: 'error',
        location: { entity: 'ladderMark', id: points[i].markId },
        message:
          `标尺非单调：标记 ${points[i].markId}（${points[i].sizeBp} bp, m=${points[i].m.toFixed(1)} px）` +
          `不小于前一标记 ${points[i - 1].markId}（${points[i - 1].sizeBp} bp）`,
      });
    }
  }
  if (nonMonotonic) {
    return { result: null, diagnostics, failureKind: 'SEMANTIC_UNSOLVABLE' };
  }

  const validRegion: ValidRegion = {
    mMin: points[0].m,
    mMax: points[points.length - 1].m,
    basis: 'lane-arc-px',
  };

  // 全局线性最小二乘（用于残差展示与 global-linear-fit 参数模式）。
  const n = points.length;
  const sumM = points.reduce((a, p) => a + p.m, 0);
  const sumL = points.reduce((a, p) => a + p.logBp, 0);
  const sumMM = points.reduce((a, p) => a + p.m * p.m, 0);
  const sumML = points.reduce((a, p) => a + p.m * p.logBp, 0);
  const denom = n * sumMM - sumM * sumM;
  const globalFit =
    denom === 0
      ? null
      : { slope: (n * sumML - sumM * sumL) / denom, intercept: (sumL - ((n * sumML - sumM * sumL) / denom) * sumM) / n };
  const residuals = points.map((p) => ({
    markId: p.markId,
    residualLogBp: globalFit ? p.logBp - (globalFit.slope * p.m + globalFit.intercept) : 0,
  }));

  return {
    result: { points, validRegion, globalFit, residuals },
    diagnostics,
    failureKind: null,
  };
}

export interface InferOptions {
  interpolation: 'piecewise-linear' | 'global-linear-fit';
}

// 用标尺把弧长坐标换算为分子量。超出有效区间只给区间，绝不伪造点值。
export function inferFromRuler(
  ruler: RulerResult,
  m: number,
  opts: InferOptions,
): { value: MwValue; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const { points, validRegion } = ruler;

  if (m < validRegion.mMin || m > validRegion.mMax) {
    const nearest = m < validRegion.mMin ? points[0] : points[points.length - 1];
    diagnostics.push({
      code: 'OUT_OF_VALID_REGION',
      severity: 'warning',
      location: { entity: 'ruler', id: 'valid-region' },
      message:
        `m=${m.toFixed(1)} px 超出标尺有效区间 [${validRegion.mMin.toFixed(1)}, ${validRegion.mMax.toFixed(1)}] px，` +
        `只能给出区间（${m < validRegion.mMin ? '大于最大 ladder 条带' : '小于最小 ladder 条带'}）`,
    });
    if (m < validRegion.mMin) {
      return {
        value: {
          kind: 'interval',
          bpMin: nearest.sizeBp,
          bpMax: Number.POSITIVE_INFINITY,
          reasons: ['OUT_OF_VALID_REGION'],
          mRange: { mMin: m, mMax: validRegion.mMin },
          validRegion,
        },
        diagnostics,
      };
    }
    return {
      value: {
        kind: 'interval',
        bpMin: 0,
        bpMax: nearest.sizeBp,
        reasons: ['OUT_OF_VALID_REGION'],
        mRange: { mMin: validRegion.mMax, mMax: m },
        validRegion,
      },
      diagnostics,
    };
  }

  if (opts.interpolation === 'global-linear-fit' && ruler.globalFit) {
    const logBp = ruler.globalFit.slope * m + ruler.globalFit.intercept;
    return {
      value: {
        kind: 'point',
        bp: Math.pow(10, logBp),
        logBp,
        m,
        segment: null,
        validRegion,
      },
      diagnostics,
    };
  }

  // 分段线性：找到 m 所在的插值段，记录段两端 ladder 点身份。
  let upper = points[0];
  let lower = points[points.length - 1];
  for (let i = 1; i < points.length; i++) {
    if (m <= points[i].m) {
      upper = points[i - 1];
      lower = points[i];
      break;
    }
  }
  const span = lower.m - upper.m;
  const t = span === 0 ? 0 : (m - upper.m) / span;
  const logBp = upper.logBp + t * (lower.logBp - upper.logBp);
  return {
    value: {
      kind: 'point',
      bp: Math.pow(10, logBp),
      logBp,
      m,
      segment: { upperMarkId: upper.markId, lowerMarkId: lower.markId },
      validRegion,
    },
    diagnostics,
  };
}
