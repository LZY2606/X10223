import { stableId } from './canonical';
import type { Diagnostic, Id, Outcome } from './types';

export interface LadderPointInput {
  pointId: Id;
  mwBp: number;
  observedY: number | null;
}

export interface RulerEnd {
  pointId: Id;
  mwBp: number;
  y: number;
}

export interface RulerSegment {
  segmentId: Id;
  a: RulerEnd;
  b: RulerEnd;
  yRange: [number, number];
  mwRange: [number, number];
  spansGap: boolean;
  missingPointIds: Id[];
}

export interface Ruler {
  points: RulerEnd[];
  segments: RulerSegment[];
}

/**
 * 由 ladder 标称值 + 观测迁移距离构建分段线性标尺（log10(bp) 对 y 分段线性）。
 * 迁移距离增大时分子量必须严格下降，否则为语义无解（非单调标尺）。
 */
export function buildRuler(inputs: LadderPointInput[]): Outcome<Ruler> {
  const observed = inputs
    .filter((p) => p.observedY !== null)
    .map((p) => ({ pointId: p.pointId, mwBp: p.mwBp, y: p.observedY as number }))
    .sort((p, q) => p.y - q.y || p.pointId.localeCompare(q.pointId));
  if (observed.length < 2) {
    return {
      ok: false,
      kind: 'SEMANTIC_UNSOLVABLE',
      diagnostics: [
        { code: 'LADDER_TOO_SPARSE', message: '已观测 ladder 条带少于 2 个，无法建立标尺', path: 'ladder.points' },
      ],
    };
  }
  for (let i = 1; i < observed.length; i++) {
    if (!(observed[i].mwBp < observed[i - 1].mwBp)) {
      return {
        ok: false,
        kind: 'SEMANTIC_UNSOLVABLE',
        diagnostics: [
          {
            code: 'RULER_NON_MONOTONIC',
            message:
              `迁移距离与分子量关系非单调: ${observed[i - 1].pointId} ` +
              `(${observed[i - 1].mwBp} bp @ y=${observed[i - 1].y} px) 之后出现 ` +
              `${observed[i].pointId} (${observed[i].mwBp} bp @ y=${observed[i].y} px)`,
            path: `ladder.points[${i}].observedY`,
          },
        ],
      };
    }
  }
  const missing = inputs
    .filter((p) => p.observedY === null)
    .map((p) => ({ pointId: p.pointId, mwBp: p.mwBp }));
  const segments: RulerSegment[] = [];
  for (let i = 1; i < observed.length; i++) {
    const a = observed[i - 1];
    const b = observed[i];
    const gap = missing.filter((m) => m.mwBp < a.mwBp && m.mwBp > b.mwBp);
    segments.push({
      segmentId: stableId('seg', [a.pointId, b.pointId]),
      a,
      b,
      yRange: [a.y, b.y],
      mwRange: [b.mwBp, a.mwBp],
      spansGap: gap.length > 0,
      missingPointIds: gap.map((m) => m.pointId),
    });
  }
  return { ok: true, value: { points: observed, segments } };
}

export type RulerEval =
  | { ok: true; log10mw: number; mwBp: number; segment: RulerSegment }
  | { ok: false; diagnostics: Diagnostic[] };

/** 在标尺上求 y 对应的分子量；超出有效区间返回带位置诊断，绝不夹取或默认。 */
export function evalRuler(ruler: Ruler, y: number): RulerEval {
  const seg = ruler.segments.find((s) => y >= s.yRange[0] && y <= s.yRange[1]);
  if (!seg) {
    const lo = ruler.segments[0].yRange[0];
    const hi = ruler.segments[ruler.segments.length - 1].yRange[1];
    return {
      ok: false,
      diagnostics: [
        {
          code: 'OUT_OF_RULER_RANGE',
          message: `y=${y.toFixed(2)} px 超出标尺有效区间 [${lo.toFixed(2)}, ${hi.toFixed(2)}] px`,
          path: 'band.center.y',
        },
      ],
    };
  }
  const t = (y - seg.a.y) / (seg.b.y - seg.a.y);
  const log10mw = Math.log10(seg.a.mwBp) + t * (Math.log10(seg.b.mwBp) - Math.log10(seg.a.mwBp));
  return { ok: true, log10mw, mwBp: Math.pow(10, log10mw), segment: seg };
}

/** 全局 log 线性拟合，仅用于残差展示（推断本身用分段标尺）。 */
export function globalLogLinearFit(points: RulerEnd[]): {
  alpha: number;
  beta: number;
  residuals: { pointId: Id; residualLog10: number }[];
} {
  const n = points.length;
  const meanY = points.reduce((s, p) => s + p.y, 0) / n;
  const meanL = points.reduce((s, p) => s + Math.log10(p.mwBp), 0) / n;
  let syy = 0;
  let syl = 0;
  for (const p of points) {
    syy += (p.y - meanY) ** 2;
    syl += (p.y - meanY) * (Math.log10(p.mwBp) - meanL);
  }
  const beta = syy === 0 ? 0 : syl / syy;
  const alpha = meanL - beta * meanY;
  return {
    alpha,
    beta,
    residuals: points.map((p) => ({
      pointId: p.pointId,
      residualLog10: Math.log10(p.mwBp) - (alpha + beta * p.y),
    })),
  };
}
