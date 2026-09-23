import type { Budget, Diagnostic, LadderPoint, Outcome, ParamSet, Ruler, RulerSegment } from '../shared/types';
import { fail, ok, spend } from '../shared/types';
import { digestOf } from '../shared/digest';

/**
 * 构建泳道标尺。规则：
 * - 至少 2 个 ladder 点，否则语义无解；
 * - log10(size) 必须随 y 严格递减（迁移越远分子越小），否则是非单调标尺 → 语义无解；
 * - 相邻点之间若跳过标称值 → 该段标记 gap（缺带），插值仍可用但降级；
 * - 标尺携带有效区域 [yMin, yMax]，区域外只能给区间/诊断。
 */
export function buildRuler(
  points: LadderPoint[],
  nominalSizesBp: number[],
  params: ParamSet,
  budget: Budget,
): Outcome<Ruler> {
  const diagnostics: Diagnostic[] = [];
  if (!spend(budget, 2)) return fail('budget_exhausted', [{ code: 'BUDGET', severity: 'error', message: '构建标尺预算耗尽', position: {} }]);
  if (points.length < 2)
    return fail('semantic_unsolvable', [
      { code: 'RULER_TOO_FEW_POINTS', severity: 'error', message: `ladder 有效点不足（${points.length}<2），无法建立标尺`, position: {} },
    ]);
  const sorted = [...points].sort((a, b) => a.yPx - b.yPx);
  for (let i = 1; i < sorted.length; i++) {
    if (!spend(budget)) return fail('budget_exhausted', [{ code: 'BUDGET', severity: 'error', message: '单调性检查预算耗尽', position: {} }]);
    const prev = sorted[i - 1], cur = sorted[i];
    if (!(cur.sizeBp < prev.sizeBp)) {
      return fail('semantic_unsolvable', [
        {
          code: 'RULER_NON_MONOTONIC',
          severity: 'error',
          message: `非单调标尺：y=${cur.yPx}px 处标称 ${cur.sizeBp}bp 不小于上一点 ${prev.sizeBp}bp`,
          position: { y: cur.yPx },
        },
      ]);
    }
  }
  // 缺带检测：相邻点的标称值在 nominal 列表中不相邻 → gap 段
  const segments: RulerSegment[] = [];
  for (let i = 1; i < sorted.length; i++) {
    const a = sorted[i - 1], b = sorted[i];
    const ia = nominalSizesBp.indexOf(a.sizeBp);
    const ib = nominalSizesBp.indexOf(b.sizeBp);
    const gap = ia >= 0 && ib >= 0 && Math.abs(ia - ib) > 1;
    if (gap)
      diagnostics.push({
        code: 'LADDER_MISSING_BAND',
        severity: 'warning',
        message: `ladder 缺带：${b.sizeBp}bp 与 ${a.sizeBp}bp 之间缺少标称带，该段插值降级`,
        position: { y: (a.yPx + b.yPx) / 2, segmentId: `seg_${i - 1}` },
      });
    segments.push({
      id: `seg_${i - 1}`,
      yLo: a.yPx,
      yHi: b.yPx,
      logLo: Math.log10(a.sizeBp),
      logHi: Math.log10(b.sizeBp),
      gap,
    });
  }
  // 全局回归（残差展示 + global 模式）
  const n = sorted.length;
  const ys = sorted.map((p) => p.yPx);
  const ls = sorted.map((p) => Math.log10(p.sizeBp));
  const my = ys.reduce((s, v) => s + v, 0) / n;
  const ml = ls.reduce((s, v) => s + v, 0) / n;
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (ys[i] - my) * (ls[i] - ml); sxx += (ys[i] - my) ** 2; }
  const bSlope = sxx === 0 ? 0 : sxy / sxx;
  const aInt = ml - bSlope * my;
  const residuals = sorted.map((p) => ({
    yPx: p.yPx,
    sizeBp: p.sizeBp,
    residual: Math.log10(p.sizeBp) - (aInt + bSlope * p.yPx),
  }));
  const ruler: Ruler = {
    id: `ruler_${digestOf({ points: sorted, v: params.version }).slice(0, 10)}`,
    paramVersion: params.version,
    points: sorted,
    segments,
    validY: { yMin: sorted[0].yPx, yMax: sorted[n - 1].yPx },
    global: { a: aInt, b: bSlope, residuals },
  };
  return ok(ruler, diagnostics);
}

export interface YMapping {
  logSize: number;
  segmentId: string | null;
  within: boolean;
  gap: boolean;
}

/** y(px) → log10(bp)。超出有效区域不失败，但 within=false，调用方必须降级为区间。 */
export function mapY(ruler: Ruler, yPx: number, params: ParamSet): YMapping {
  const within = yPx >= ruler.validY.yMin && yPx <= ruler.validY.yMax;
  if (params.interpolation === 'global-log-linear') {
    return { logSize: ruler.global.a + ruler.global.b * yPx, segmentId: null, within, gap: false };
  }
  const seg = ruler.segments.find((s) => yPx >= s.yLo && yPx <= s.yHi);
  if (!seg) {
    // 区域外：用最近段外推，但标记 within=false
    const edge = yPx < ruler.validY.yMin ? ruler.segments[0] : ruler.segments[ruler.segments.length - 1];
    const t = (yPx - edge.yLo) / (edge.yHi - edge.yLo);
    return { logSize: edge.logLo + t * (edge.logHi - edge.logLo), segmentId: edge.id, within: false, gap: edge.gap };
  }
  const t = (yPx - seg.yLo) / (seg.yHi - seg.yLo);
  return { logSize: seg.logLo + t * (seg.logHi - seg.logLo), segmentId: seg.id, within: true, gap: seg.gap };
}

/**
 * 局部标尺：微笑弯曲下，同一图像高度在不同泳道对应不同迁移距离。
 * 局部标尺的有效区域是「泳道曲线落在全局有效 y 区间内」的 x 范围。
 */
export function localValidXRange(
  ruler: Ruler,
  curveOffsetAtLaneCenter: number,
): { xValid: boolean; note: string } {
  const yMin = ruler.validY.yMin + curveOffsetAtLaneCenter;
  const yMax = ruler.validY.yMax + curveOffsetAtLaneCenter;
  return {
    xValid: yMax > yMin,
    note: `本泳道有效区间平移到 y∈[${yMin.toFixed(1)}, ${yMax.toFixed(1)}]px（曲线偏移 ${curveOffsetAtLaneCenter.toFixed(1)}px）`,
  };
}
