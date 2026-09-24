import type { Diagnostic } from '../shared/diagnostic';
import { makeId } from '../shared/ids';
import type { BandObservation, CalibrationSegment, MwEstimate, ParamSet } from '../shared/types';
import { rfAt, type LaneCurve } from './lanes';

export interface InferInput {
  band: BandObservation;
  laneCurve: LaneCurve;
  segments: CalibrationSegment[];   // 仅本 ladder 泳道的有效段
  params: ParamSet;
}

function sizeAt(seg: CalibrationSegment, rf: number): number {
  return Math.pow(10, seg.slope * rf + seg.intercept);
}

/**
 * 由局部标尺段推断分子量。
 * 规则：
 *  - 只在段的有效区间内插值；区间外 => invalid，绝不外推。
 *  - 饱和/拖尾/重叠条带只能给出候选或区间，不给唯一点估计。
 *  - 无法唯一决定时保留全部合法候选。
 */
export function estimateMw(input: InferInput): MwEstimate {
  const { band, laneCurve, segments, params } = input;
  const diagnostics: Diagnostic[] = [];
  const rf = rfAt(laneCurve, band.center.y);
  const path = `bands[${band.id}]`;

  const covering = segments.filter(
    (s) => rf >= s.validRange.rfMin && rf <= s.validRange.rfMax,
  );

  const base = {
    kind: 'mw-estimate' as const,
    bandId: band.id,
    laneIndex: band.laneIndex,
    rf,
    ladderPointIds: [] as string[],
    diagnostics,
    provenance: { imageId: band.provenance.imageId, frame: 'image' as const },
  };

  if (covering.length === 0) {
    diagnostics.push({
      severity: 'error', code: 'infer/outside-valid-range',
      message: `rf=${rf.toFixed(4)} 不在任何有效标尺段内，不外推`,
      path,
      position: { pixel: { x: band.center.x, y: band.center.y }, objectId: band.id },
    });
    return {
      ...base,
      id: makeId('mw', band.id, 'invalid', params.version),
      status: 'invalid',
    };
  }

  // 多个段覆盖同一 rf（重叠区间）=> 保留全部合法候选
  const candidates = covering.map((s) => ({ valueBp: sizeAt(s, rf), segmentId: s.id }));
  const ladderPointIds = [...new Set(covering.flatMap((s) => s.ladderPointIds))];

  // 区间估计：中心位置不确定（饱和/拖尾）时，用半高换算 rf 区间
  const rfSpan = laneCurve.yBottom - laneCurve.yTop;
  const drf = band.halfHeightPx.value / Math.max(1, rfSpan);
  const intervalOf = (seg: CalibrationSegment): [number, number] => [
    sizeAt(seg, Math.min(seg.validRange.rfMax, rf + drf)),
    sizeAt(seg, Math.max(seg.validRange.rfMin, rf - drf)),
  ];

  let status: MwEstimate['status'] = 'ok';
  let intervalBp: [number, number] | undefined;
  if (band.saturated) {
    status = 'interval';
    intervalBp = intervalOf(covering[0]);
    diagnostics.push({
      severity: 'warning', code: 'infer/saturated-band',
      message: '条带饱和，峰形截断，只能给出区间估计',
      path, position: { pixel: { x: band.center.x, y: band.center.y }, objectId: band.id },
    });
  } else if (band.trailing) {
    status = 'interval';
    intervalBp = intervalOf(covering[0]);
    diagnostics.push({
      severity: 'warning', code: 'infer/trailing-band',
      message: '条带拖尾，中心不可靠，只能给出区间估计',
      path, position: { pixel: { x: band.center.x, y: band.center.y }, objectId: band.id },
    });
  } else if (band.overlapping || candidates.length > 1) {
    status = 'candidate';
    diagnostics.push({
      severity: 'warning', code: 'infer/ambiguous-band',
      message: band.overlapping ? '条带重叠，只能作为候选' : '多个标尺段覆盖该位置，保留全部候选',
      path, position: { pixel: { x: band.center.x, y: band.center.y }, objectId: band.id },
    });
  }

  const primary = candidates[0];
  return {
    ...base,
    id: makeId('mw', band.id, primary.segmentId, params.version),
    status,
    valueBp: status === 'ok' ? primary.valueBp : undefined,
    intervalBp,
    segmentId: primary.segmentId,
    ladderPointIds,
    candidates: candidates.length > 1 || status !== 'ok' ? candidates : undefined,
  };
}
