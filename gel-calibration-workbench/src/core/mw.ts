import type {
  BandCenter,
  Diagnostic,
  LaneCurveResult,
  MwResult,
  ParamSet,
  RulerResult,
} from '../shared/types';
import { pixelToArc } from './lanes';
import { inferFromRuler } from './ruler';
import type { BandAssessment } from './bands';

export interface MwInferOutcome {
  results: MwResult[];
  diagnostics: Diagnostic[];
}

// 单条泳道内，把条带中心换算为分子量推断。
// 关键规则：同一像素高度 ≠ 同一分子量（微笑弯曲），必须用本泳道弧长坐标 + 局部标尺有效区间。
export function inferMwForLane(
  laneId: string,
  curve: LaneCurveResult,
  ruler: RulerResult,
  bands: BandCenter[],
  assessments: Map<string, BandAssessment>,
  params: ParamSet,
): MwInferOutcome {
  const diagnostics: Diagnostic[] = [];
  const results: MwResult[] = [];
  const sorted = [...bands].sort((a, b) => a.position.y - b.position.y || a.id.localeCompare(b.id));

  for (const band of sorted) {
    const assessment = assessments.get(band.id);
    const arc = pixelToArc(curve, band.position);
    if (!arc) {
      diagnostics.push({
        code: 'BAND_OFF_LANE',
        severity: 'error',
        location: { entity: 'bandCenter', id: band.id, point: band.position },
        message: `条带 ${band.id} 无法投影到泳道 ${laneId} 的中心线`,
      });
      continue;
    }
    if (arc.distancePx > 24) {
      diagnostics.push({
        code: 'BAND_OFF_LANE',
        severity: 'warning',
        location: { entity: 'bandCenter', id: band.id, point: band.position },
        message: `条带 ${band.id} 距泳道中心线 ${arc.distancePx.toFixed(1)} px，超出容差`,
      });
    }

    const reasons = assessment ? [...assessment.reasons] : [];
    const candidates = assessment ? assessment.candidates : [];

    if (assessment && !assessment.pointReliable) {
      // 饱和 / 拖尾 / 重叠：只能给候选或区间
      const half = assessment.intervalHalfWidthPx;
      const lo = inferFromRuler(ruler, arc.s + half, { interpolation: params.interpolation });
      const hi = inferFromRuler(ruler, Math.max(0, arc.s - half), { interpolation: params.interpolation });
      const bpOf = (v: typeof lo.value): number =>
        v.kind === 'point' ? v.bp : v.kind === 'interval' ? (Number.isFinite(v.bpMax) ? v.bpMax : v.bpMin) : 0;
      const bpMin = Math.min(bpOf(lo.value), bpOf(hi.value));
      const bpMax = Math.max(bpOf(lo.value), bpOf(hi.value));
      const allReasons = [...reasons];
      for (const d of [...lo.diagnostics, ...hi.diagnostics]) {
        if (d.code === 'OUT_OF_VALID_REGION' && !allReasons.includes('OUT_OF_VALID_REGION')) {
          allReasons.push('OUT_OF_VALID_REGION');
        }
      }
      results.push({
        bandId: band.id,
        laneId,
        status: 'candidate',
        value: {
          kind: 'interval',
          bpMin,
          bpMax,
          reasons: allReasons,
          mRange: { mMin: arc.s - half, mMax: arc.s + half },
          validRegion: ruler.validRegion,
        },
        candidates,
      });
      continue;
    }

    const inferred = inferFromRuler(ruler, arc.s, { interpolation: params.interpolation });
    diagnostics.push(...inferred.diagnostics);
    if (inferred.value.kind === 'interval') {
      results.push({
        bandId: band.id,
        laneId,
        status: 'interval',
        value: inferred.value,
        candidates,
      });
    } else {
      results.push({
        bandId: band.id,
        laneId,
        status: 'point',
        value: inferred.value,
        candidates,
      });
    }
  }

  return { results, diagnostics };
}
