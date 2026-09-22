import type { Diagnostic, Id, Interval } from './types';

/** ladder 上一个已知条带：迁移坐标 t（px）与 log10(分子量/bp)。 */
export interface LadderPoint {
  bandId: Id;
  t: number;
  log10Bp: number;
}

export type SegmentStatus = 'valid' | 'gap' | 'invalid';

/** 插值段：局部标尺，必须带有效区域。 */
export interface ScaleSegment {
  id: string;
  laneId: Id;
  /** 有效区域：迁移坐标区间 [t0, t1]（px） */
  t0: number;
  t1: number;
  log0: number;
  log1: number;
  status: SegmentStatus;
  reason?: string;
}

export interface LaneScale {
  laneId: Id;
  segments: ScaleSegment[];
  /** 有效区域：ladder 最上/最下已知点之间 */
  validRange: Interval | null;
  diagnostics: Diagnostic[];
  paramVersion: string;
}

export interface BuildScaleOptions {
  paramVersion: string;
  /** 缺带（nominal 缺失/不可转换）的 bandId 集合 */
  missingBandIds?: Set<Id>;
}

/**
 * 由 ladder 点构建局部标尺。
 * 迁移坐标 t 增大（条带跑得越远）时 log10Bp 必须严格下降；
 * 非单调 → 语义无解：相关段标 invalid 并给出带位置的诊断。
 * 缺带点不产生插值段，其跨越区间标 gap，只能给出区间估计。
 */
export function buildLaneScale(laneId: Id, points: LadderPoint[], opts: BuildScaleOptions): LaneScale {
  const diagnostics: Diagnostic[] = [];
  const sorted = [...points].sort((p, q) => p.t - q.t);
  const missing = opts.missingBandIds ?? new Set<Id>();
  const known = sorted.filter((p) => !missing.has(p.bandId));

  const segments: ScaleSegment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const id = `seg_${laneId}_${i}`;
    const aMissing = missing.has(a.bandId);
    const bMissing = missing.has(b.bandId);
    if (aMissing || bMissing) {
      segments.push({
        id, laneId, t0: a.t, t1: b.t,
        log0: aMissing ? NaN : a.log10Bp,
        log1: bMissing ? NaN : b.log10Bp,
        status: 'gap',
        reason: `ladder 缺带：${aMissing ? a.bandId : b.bandId}，该区间只能给出区间估计`,
      });
      diagnostics.push({
        code: 'LADDER_GAP',
        message: `ladder 缺带导致段 ${id} 无法唯一定标`,
        path: `lanes[${laneId}].segments[${id}]`,
        severity: 'warning',
      });
      continue;
    }
    if (!(a.log10Bp > b.log10Bp)) {
      segments.push({
        id, laneId, t0: a.t, t1: b.t, log0: a.log10Bp, log1: b.log10Bp,
        status: 'invalid',
        reason: '非单调标尺：迁移距离增大时分子量未下降',
      });
      diagnostics.push({
        code: 'NON_MONOTONIC_SCALE',
        message: `段 ${id} 非单调：log10Bp ${a.log10Bp} -> ${b.log10Bp}`,
        path: `lanes[${laneId}].segments[${id}]`,
        severity: 'error',
      });
      continue;
    }
    segments.push({ id, laneId, t0: a.t, t1: b.t, log0: a.log10Bp, log1: b.log10Bp, status: 'valid' });
  }

  const validRange = known.length >= 2 ? { min: known[0].t, max: known[known.length - 1].t } : null;
  if (!validRange) {
    diagnostics.push({
      code: 'INSUFFICIENT_LADDER',
      message: '已知 ladder 点不足两个，无法建立局部标尺',
      path: `lanes[${laneId}]`,
      severity: 'error',
    });
  }
  return { laneId, segments, validRange, diagnostics, paramVersion: opts.paramVersion };
}

/** 在标尺上定位 t：返回命中的段，或 null（超出有效区域=外推）。 */
export function locateSegment(scale: LaneScale, t: number): ScaleSegment | null {
  for (const seg of scale.segments) {
    if (t >= seg.t0 && t <= seg.t1) return seg;
  }
  return null;
}

/** 段内线性插值 log10Bp。 */
export function interpLog10Bp(seg: ScaleSegment, t: number): number {
  const f = (t - seg.t0) / (seg.t1 - seg.t0);
  return seg.log0 + f * (seg.log1 - seg.log0);
}
