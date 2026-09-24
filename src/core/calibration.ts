import { ok, type Outcome, type Diagnostic } from '../shared/diagnostic';
import { makeId } from '../shared/ids';
import type { BandObservation, CalibrationSegment, LadderNominal, ParamSet } from '../shared/types';
import { rfAt, type LaneCurve } from './lanes';

export interface LadderPoint {
  bandId: string;
  rf: number;
  sizeBp: number;
  logSize: number;
  pixel: { x: number; y: number };
}

export interface CalibrationResult {
  points: LadderPoint[];
  segments: CalibrationSegment[];
  /** 因非单调等原因被判失效的 rf 区间 */
  invalidRanges: { rfMin: number; rfMax: number; reason: string }[];
  diagnostics: Diagnostic[];
}

/**
 * 由 ladder 泳道构建局部标尺。
 * - 条带与标称片段按迁移顺序对齐（胶顶=大分子）；缺带通过 excludedOrdinals 显式声明。
 * - 单调性：分子量越大 rf 必须越小；违反的相邻段判为 semantically 失效并带像素位置诊断。
 * - 每段只在 [rfMin, rfMax] 内有效，绝不外推。
 */
export function buildCalibration(
  ladderBands: BandObservation[],
  nominal: LadderNominal,
  curve: LaneCurve,
  params: ParamSet,
  excludedOrdinals: number[] = [],
): Outcome<CalibrationResult> {
  const diagnostics: Diagnostic[] = [];
  const path = `ladder[lane=${nominal.laneIndex}]`;

  const fragments = nominal.fragments
    .filter((f) => !excludedOrdinals.includes(f.ordinal))
    .sort((a, b) => b.size.value - a.size.value); // 大分子在上
  const bands = [...ladderBands].sort((a, b) => a.center.y - b.center.y);

  if (bands.length !== fragments.length) {
    diagnostics.push({
      severity: 'error', code: 'ladder/count-mismatch',
      message: `ladder 泳道检测到 ${bands.length} 条条带，但标称片段（扣除缺带后）为 ${fragments.length} 个；缺失位置需要显式声明`,
      path,
      position: bands[0] ? { pixel: { x: bands[0].center.x, y: bands[0].center.y } } : undefined,
    });
  }
  const pairCount = Math.min(bands.length, fragments.length);
  if (pairCount < params.minLadderPoints) {
    diagnostics.push({
      severity: 'error', code: 'ladder/too-few-points',
      message: `可用 ladder 点 ${pairCount} 个，少于参数要求 ${params.minLadderPoints} 个`,
      path,
    });
    return ok({ points: [], segments: [], invalidRanges: [], diagnostics });
  }

  const points: LadderPoint[] = [];
  for (let i = 0; i < pairCount; i++) {
    const band = bands[i];
    const frag = fragments[i];
    points.push({
      bandId: band.id,
      rf: rfAt(curve, band.center.y),
      sizeBp: frag.size.value,
      logSize: Math.log10(frag.size.value),
      pixel: { x: band.center.x, y: band.center.y },
    });
  }

  // 单调性检查：rf 必须随标称尺寸递减而递增
  const invalidRanges: CalibrationResult['invalidRanges'] = [];
  const badIndex = new Set<number>();
  for (let i = 0; i + 1 < points.length; i++) {
    if (!(points[i + 1].rf > points[i].rf)) {
      badIndex.add(i); badIndex.add(i + 1);
      invalidRanges.push({
        rfMin: Math.min(points[i].rf, points[i + 1].rf),
        rfMax: Math.max(points[i].rf, points[i + 1].rf),
        reason: `非单调标尺：${points[i].sizeBp}bp 与 ${points[i + 1].sizeBp}bp 的迁移顺序与标称尺寸矛盾`,
      });
      diagnostics.push({
        severity: 'error', code: 'ladder/non-monotonic',
        message: `非单调标尺：标称 ${points[i].sizeBp}bp（rf=${points[i].rf.toFixed(4)}）与 ${points[i + 1].sizeBp}bp（rf=${points[i + 1].rf.toFixed(4)}）迁移顺序矛盾，相关插值段失效`,
        path: `${path}.fragments[${i}]`,
        position: { pixel: points[i].pixel, objectId: points[i].bandId },
      });
    }
  }

  // 留一法残差：衡量局部非线性（用于残差曲线展示）
  const looResidual = (i: number): number => {
    if (i === 0 || i === points.length - 1 || points.length < 3) return 0;
    const a = points[i - 1], b = points[i + 1];
    if (b.rf === a.rf) return 0;
    const slope = (b.logSize - a.logSize) / (b.rf - a.rf);
    const pred = a.logSize + slope * (points[i].rf - a.rf);
    return Math.abs(pred - points[i].logSize);
  };

  const segments: CalibrationSegment[] = [];
  for (let i = 0; i + 1 < points.length; i++) {
    const a = points[i], b = points[i + 1];
    if (badIndex.has(i) || badIndex.has(i + 1)) continue; // 失效段不产出
    const slope = (b.logSize - a.logSize) / (b.rf - a.rf);
    const intercept = a.logSize - slope * a.rf;
    const residual = Math.max(looResidual(i), looResidual(i + 1));
    segments.push({
      id: makeId('seg', nominal.laneIndex, a.bandId, b.bandId, params.version),
      kind: 'calibration-segment',
      ladderLaneIndex: nominal.laneIndex,
      lower: { bandId: a.bandId, rf: a.rf, sizeBp: a.sizeBp },
      upper: { bandId: b.bandId, rf: b.rf, sizeBp: b.sizeBp },
      slope,
      intercept,
      validRange: { rfMin: a.rf, rfMax: b.rf },
      residual,
      ladderPointIds: [a.bandId, b.bandId],
      provenance: { note: `params=${params.version}` },
    });
  }
  return ok({ points, segments, invalidRanges, diagnostics });
}
