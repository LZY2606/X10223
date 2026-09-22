import type { Diagnostic, MwEstimate } from './core';
import { inferMw, type LocalScale } from './scale';

/** 条带证据（像素级来源，analysis 帧） */
export interface BandEvidence {
  bandId: string;
  laneId: string;
  x: number;
  yPeak: number;
  yTop: number;
  yBottom: number;
  peakIntensity: number;
  saturated: boolean;
  trailing: boolean;
  /** 同一重叠组的条带共享 groupId；组内条带数 > 1 表示峰重叠 */
  overlapGroupId?: string;
  overlapGroupSize?: number;
}

export interface BandAssessment {
  bandId: string;
  /** point=唯一确定；candidate=只能标为候选或区间 */
  status: 'point' | 'candidate';
  reasons: string[];
  estimate: MwEstimate;
  /** 无法唯一决定时保留全部合法候选 */
  alternatives: MwEstimate[];
  diagnostics: Diagnostic[];
}

/**
 * 条带评估：
 * - 饱和：中心不可信 -> 区间候选 [infer(yBottom), infer(yTop)]
 * - 拖尾：峰位偏移 -> 候选点
 * - 重叠：保留全部合法候选（各峰点估计 + 合并区间）
 */
export function assessBand(ev: BandEvidence, scale: LocalScale): BandAssessment {
  const diagnostics: Diagnostic[] = [];
  const reasons: string[] = [];
  const alternatives: MwEstimate[] = [];

  if (ev.saturated) {
    reasons.push('saturated');
    const lo = inferMw(scale, ev.yBottom); // 下缘 -> 低分子量端
    const hi = inferMw(scale, ev.yTop); // 上缘 -> 高分子量端
    if (lo.kind === 'invalid') diagnostics.push(lo.diagnostic);
    if (hi.kind === 'invalid') diagnostics.push(hi.diagnostic);
    if (lo.kind === 'point' && hi.kind === 'point') {
      return {
        bandId: ev.bandId,
        status: 'candidate',
        reasons,
        estimate: { kind: 'interval', loMw: lo.mw, hiMw: hi.mw, reason: 'saturated' },
        alternatives,
        diagnostics,
      };
    }
    return {
      bandId: ev.bandId,
      status: 'candidate',
      reasons,
      estimate: { kind: 'invalid', diagnostic: diagnostics[0] ?? { code: 'SATURATED_UNBOUNDED', message: '饱和条带且边界超出有效区域' } },
      alternatives,
      diagnostics,
    };
  }

  const peak = inferMw(scale, ev.yPeak);
  if (peak.kind === 'invalid') diagnostics.push(peak.diagnostic);

  if ((ev.overlapGroupSize ?? 1) > 1) {
    reasons.push('overlap');
    // 合法候选：本峰点估计 + 整组合并区间
    if (peak.kind === 'point') alternatives.push(peak);
    const lo = inferMw(scale, ev.yBottom);
    const hi = inferMw(scale, ev.yTop);
    if (lo.kind === 'point' && hi.kind === 'point') {
      alternatives.push({ kind: 'interval', loMw: lo.mw, hiMw: hi.mw, reason: 'overlap-merged' });
    }
    return {
      bandId: ev.bandId,
      status: 'candidate',
      reasons,
      estimate: peak,
      alternatives,
      diagnostics,
    };
  }

  if (ev.trailing) {
    reasons.push('trailing');
    return { bandId: ev.bandId, status: 'candidate', reasons, estimate: peak, alternatives, diagnostics };
  }

  return { bandId: ev.bandId, status: peak.kind === 'point' ? 'point' : 'candidate', reasons, estimate: peak, alternatives, diagnostics };
}
