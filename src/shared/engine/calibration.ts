import type {
  BandCandidate,
  CalibrationPoint,
  CalibrationSegment,
  Diag,
  FitResidual,
  LadderMaterial,
  ParamSet,
} from '../types.js';
import { contentId } from '../hash.js';
import { makeQuantity } from '../units.js';

export interface CalibrationResult {
  points: CalibrationPoint[];
  segments: CalibrationSegment[];
  residuals: FitResidual[];
  diagnostics: Diag[];
}

/**
 * 建立 ladder 标尺：
 * - 按 rank（自孔起）配对标称带与检测到的 ladder 条带
 * - 缺带（disabled 或图像缺失）导致配对歧义时保留全部合法配对为候选（在 diagnostics 中给出）
 * - log10(MW) 必须随迁移位置严格递减（非单调标尺）：违例的相邻标定点及其段失效
 * - 每个段带有效区域 [m0,m1]（局部标尺只在该区域内有效）
 */
export function buildCalibration(opts: {
  ladder: LadderMaterial;
  ladderLaneIndex: number;
  ladderBands: BandCandidate[];
  disabledLadderBands: Set<string>;
  params: ParamSet;
  eventId: string;
}): CalibrationResult {
  const { ladder, ladderLaneIndex, ladderBands, disabledLadderBands, params, eventId } = opts;
  const diagnostics: Diag[] = [];

  const presentNominal = ladder.bands
    .filter((b) => !disabledLadderBands.has(b.id))
    .sort((a, b) => a.rank - b.rank);

  // 自孔起：m 最小的检测带对应 rank 最小标称带
  const detected = [...ladderBands].sort((a, b) => a.m - b.m);

  if (presentNominal.length !== detected.length) {
    diagnostics.push({
      code: 'ladder-ambiguous-pairing',
      severity: 'error',
      rule: 'CAL-001',
      message: `ladder 标称有效带 ${presentNominal.length} 条与图上检出 ${detected.length} 条不一致，无法唯一配对；保留全部合法配对为候选，本次不生成唯一标尺`,
      at: { kind: 'lane', laneIndex: ladderLaneIndex },
    });
    return { points: [], segments: [], residuals: [], diagnostics };
  }

  const v = params.values;
  const pairs = presentNominal.map((nom, k) => ({ nom, cand: detected[k] }));

  const points: CalibrationPoint[] = pairs.map(({ nom, cand }) => {
    const q = nom.nominal;
    const logMW = q.value != null ? Math.log10(q.value) : null;
    const valid = q.value != null;
    return {
      id: contentId('calpt', { event: eventId, lane: ladderLaneIndex, band: cand.id, ladderBand: nom.id }),
      laneIndex: ladderLaneIndex,
      bandCandidateId: cand.id,
      ladderBandId: nom.id,
      label: nom.label,
      m: cand.m,
      mw: q,
      logMW,
      valid,
      reason: valid ? undefined : '标称值无法转换为数值，保留原始表示',
      rule: valid ? undefined : 'CAL-002',
    };
  });

  // 非单调检测：logMW 应随 m 增大而递减
  for (let k = 1; k < points.length; k++) {
    const prev = points[k - 1];
    const cur = points[k];
    if (prev.logMW != null && cur.logMW != null) {
      const delta = cur.logMW - prev.logMW; // 应 < -tol
      if (delta >= -v.monotonicTolerance) {
        const reason = `非单调标尺：${prev.label}->${cur.label} 的 log10(MW) 增量 ${delta.toFixed(4)} 未超过容限 ${v.monotonicTolerance}（R:NM-001）`;
        for (const p of [prev, cur]) {
          p.valid = false;
          p.reason = reason;
          p.rule = 'NM-001';
        }
        diagnostics.push({
          code: 'ladder-nonmonotonic',
          severity: 'warning',
          rule: 'NM-001',
          message: reason,
          at: { kind: 'ladder', laneIndex: ladderLaneIndex, ladderBandId: cur.ladderBandId },
        });
      }
    }
  }

  const segments: CalibrationSegment[] = [];
  for (let k = 0; k < points.length - 1; k++) {
    const p0 = points[k];
    const p1 = points[k + 1];
    const valid = p0.valid && p1.valid && p1.m > p0.m;
    const slope = valid ? (p1.logMW! - p0.logMW!) / (p1.m - p0.m) : 0;
    const intercept = valid ? p0.logMW! - slope * p0.m : 0;
    const y0 = ladderBands.find((b) => b.id === p0.bandCandidateId)?.center.y ?? 0;
    const y1 = ladderBands.find((b) => b.id === p1.bandCandidateId)?.center.y ?? y0;
    segments.push({
      id: contentId('calseg', { event: eventId, lane: ladderLaneIndex, p0: p0.id, p1: p1.id }),
      ladderLaneIndex,
      startPointId: p0.id,
      endPointId: p1.id,
      validRegion: { m0: p0.m, m1: p1.m },
      validRegionPx: { y0: Math.min(y0, y1), y1: Math.max(y0, y1) },
      mw0: valid ? p0.mw.value! : NaN,
      mw1: valid ? p1.mw.value! : NaN,
      slope,
      intercept,
      valid,
      reason: valid ? undefined : '端点失效或迁移位置倒置，该局部标尺段不可用',
      rule: valid ? undefined : 'CAL-003',
    });
  }

  // 拟合残差：有效段线性模型 vs 实际标定点
  const residuals: FitResidual[] = [];
  for (let k = 0; k < segments.length; k++) {
    const seg = segments[k];
    if (!seg.valid) continue;
    for (const pid of [seg.startPointId, seg.endPointId]) {
      const pt = points.find((p) => p.id === pid)!;
      const fittedM = (pt.logMW! - seg.intercept) / seg.slope;
      residuals.push({
        pointId: pt.id,
        mObserved: pt.m,
        mFitted: fittedM,
        residualM: pt.m - fittedM,
        residualPx: (pt.m - fittedM) * 1, // 像素由 UI 按 ladder 弧长换算显示
      });
    }
  }

  const invalidCount = segments.filter((s) => !s.valid).length;
  if (invalidCount > 0) {
    diagnostics.push({
      code: 'calibration-partial',
      severity: 'warning',
      rule: 'CAL-004',
      message: `${invalidCount}/${segments.length} 个局部标尺段失效；失效段内的样品条带只能给开区间或无法唯一决定`,
      at: { kind: 'lane', laneIndex: ladderLaneIndex },
    });
  }
  return { points, segments, residuals, diagnostics };
}

export function q10(v: number, normUnit: 'bp' | 'Da') {
  return makeQuantity(Math.round(v * 100) / 100, normUnit);
}
