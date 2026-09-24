import type { Diagnostic } from '../shared/diagnostic';
import type {
  BandObservation, CalibrationSegment, DecisionRecord, LaneObservation,
  LadderNominal, Material, MwEstimate, ParamSet,
} from '../shared/types';
import { buildCalibration, type LadderPoint } from './calibration';
import { estimateMw } from './infer';
import { fitLaneCurve, type LaneCurve } from './lanes';

export interface DerivedOutput {
  segments: CalibrationSegment[];
  estimates: MwEstimate[];
  laneCurves: { laneIndex: number; curve: LaneCurve }[];
  ladderPoints: LadderPoint[];
  invalidRanges: { rfMin: number; rfMax: number; reason: string }[];
  diagnostics: Diagnostic[];
}

/**
 * 纯函数派生管线：材料 + 参数版本 + 决定 => 派生结果。
 * 派生 id 由内容哈希决定：未受影响的输入变化不会改变无关结果的 id（局部失效可验证）。
 */
export function computeDerived(
  materials: Material[],
  params: ParamSet,
  decisions: DecisionRecord[],
): DerivedOutput {
  const diagnostics: Diagnostic[] = [];
  const lanes = materials.filter((m): m is LaneObservation => m.kind === 'lane-observation');
  const bands = materials.filter((m): m is BandObservation => m.kind === 'band-observation');
  const nominal = materials.find((m): m is LadderNominal => m.kind === 'ladder-nominal');

  const excludedBandIds = new Set(
    decisions.filter((d) => d.action === 'exclude-band')
      .map((d) => (d.payload as { bandId?: string })?.bandId ?? d.subjectId),
  );

  // 拟合每条泳道曲线
  const laneCurves: DerivedOutput['laneCurves'] = [];
  const curveByLane = new Map<number, LaneCurve>();
  for (const lane of lanes) {
    const fit = fitLaneCurve(lane.centerline);
    if (fit.ok) {
      laneCurves.push({ laneIndex: lane.laneIndex, curve: fit.value });
      curveByLane.set(lane.laneIndex, fit.value);
      diagnostics.push(...fit.warnings);
    } else {
      diagnostics.push(...fit.diagnostics.map((d) => ({ ...d, position: { ...d.position, objectId: lane.id } })));
    }
  }

  const ladderLane = lanes.find((l) => l.role === 'ladder');
  const result: DerivedOutput = {
    segments: [], estimates: [], laneCurves, ladderPoints: [], invalidRanges: [], diagnostics,
  };
  if (!nominal || !ladderLane) {
    diagnostics.push({
      severity: 'error', code: 'pipeline/missing-ladder',
      message: '缺少 ladder 标称值或 ladder 泳道，无法建立标尺',
      path: 'materials',
    });
    return result;
  }
  const ladderCurve = curveByLane.get(ladderLane.laneIndex);
  if (!ladderCurve) return result;

  const activeBands = bands.filter((b) => !excludedBandIds.has(b.id));
  const ladderBands = activeBands.filter((b) => b.laneIndex === ladderLane.laneIndex);

  // 缺带：先按完整顺序对齐，找出被排除条带对应的标称序，再重建
  let excludedOrdinals: number[] = [];
  const excludedLadder = bands.filter(
    (b) => b.laneIndex === ladderLane.laneIndex && excludedBandIds.has(b.id),
  );
  if (excludedLadder.length > 0) {
    const frags = [...nominal.fragments].sort((a, b) => b.size.value - a.size.value);
    const all = [...bands.filter((b) => b.laneIndex === ladderLane.laneIndex)]
      .sort((a, b) => a.center.y - b.center.y);
    for (const ex of excludedLadder) {
      const idx = all.findIndex((b) => b.id === ex.id);
      if (idx >= 0 && idx < frags.length) excludedOrdinals.push(frags[idx].ordinal);
    }
  }

  const cal = buildCalibration(ladderBands, nominal, ladderCurve, params, excludedOrdinals);
  if (cal.ok) {
    result.segments = cal.value.segments;
    result.ladderPoints = cal.value.points;
    result.invalidRanges = cal.value.invalidRanges;
    diagnostics.push(...cal.value.diagnostics);
  } else {
    diagnostics.push(...cal.diagnostics);
  }

  // 样品泳道逐带推断
  for (const band of activeBands) {
    if (band.laneIndex === ladderLane.laneIndex) continue;
    const curve = curveByLane.get(band.laneIndex);
    if (!curve) {
      diagnostics.push({
        severity: 'error', code: 'pipeline/no-lane-curve',
        message: `条带所在泳道 ${band.laneIndex} 无可用曲线`,
        path: `bands[${band.id}]`,
        position: { pixel: { x: band.center.x, y: band.center.y }, objectId: band.id },
      });
      continue;
    }
    result.estimates.push(estimateMw({ band, laneCurve: curve, segments: result.segments, params }));
  }
  return result;
}
