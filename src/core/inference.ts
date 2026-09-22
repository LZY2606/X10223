import type {
  BandAnnotation,
  CalibrationFit,
  CalibrationSegment,
  GelInput,
  LaneAnnotation,
  MwCandidate,
  MwInference,
} from './types';
import { stableId } from '../shared/ids';
import { bpLabel } from '../shared/units';
import type { Diagnostic } from '../shared/diagnostic';
import { curvatureSmile, projectToLane } from './geometry';
import { CALIBRATION_PARAM_VERSION } from './calibration';

export const INFERENCE_PARAM_VERSION = 'infer.v4';
/** “微笑”超过该横向偏移（px），强制要求弧长局部标尺，拒绝高度直读。 */
export const CURVATURE_THRESHOLD_PX = 4;

export function inferBand(
  band: BandAnnotation,
  lane: LaneAnnotation,
  fit: CalibrationFit,
): MwInference {
  const diagnostics: Diagnostic[] = [];
  const proj = projectToLane(lane, band.center);
  const s = proj.s;

  const smile = curvatureSmile(lane);
  if (smile > CURVATURE_THRESHOLD_PX) {
    diagnostics.push({
      code: 'curved-lane-requires-local-scale',
      severity: 'warning',
      message: `泳道“微笑”弯曲 ${smile.toFixed(1)}px：同一像素高度不等于同一分子量，使用弧长局部标尺`,
      location: { laneId: lane.laneId, bandId: band.bandId, x: band.center.x, y: band.center.y },
    });
  }

  const segment = fit.segments.find((g) => s >= g.sMin && s <= g.sMax);

  if (!segment) {
    diagnostics.push({
      code: 'outside-valid-region',
      severity: 'error',
      message: `条带弧长 s=${s.toFixed(1)}px 落在全部插值段有效区域之外，拒绝外推`,
      location: { laneId: lane.laneId, bandId: band.bandId, x: band.center.x, y: band.center.y },
    });
    return unresolved(band, diagnostics, s, fit);
  }

  if (segment.status === 'non-monotonic') {
    diagnostics.push({
      code: 'non-monotonic-calibration',
      severity: 'error',
      message: '所落插值段非单调，分子量语义无解；相邻 ladder 点未保持单调',
      location: {
        laneId: lane.laneId,
        bandId: band.bandId,
        segmentId: segment.segmentId,
        x: band.center.x,
        y: band.center.y,
      },
    });
    return unresolved(band, diagnostics, s, fit);
  }

  const bp = 10 ** (segment.intercept - segment.slope * s);
  const reasons: MwCandidate['reason'][] = [];
  let status: MwInference['status'] = 'unique';

  if (band.saturated) {
    reasons.push('saturated');
    status = 'candidate-set';
    diagnostics.push({
      code: 'saturated-band',
      severity: 'warning',
      message: '饱和条带：峰心被截断，中心不可靠，仅给候选/区间',
      location: { laneId: lane.laneId, bandId: band.bandId, y: band.center.y },
    });
  }
  if (band.overlapsWith.length > 0) {
    reasons.push('overlap');
    status = 'candidate-set';
    diagnostics.push({
      code: 'overlapping-bands',
      severity: 'warning',
      message: `条带与 ${band.overlapsWith.length} 条带重叠，保留全部合法候选`,
      location: { laneId: lane.laneId, bandId: band.bandId, y: band.center.y },
    });
  }
  if (band.tailed) {
    reasons.push('tail');
    if (status === 'unique') status = 'interval';
    diagnostics.push({
      code: 'tailed-band',
      severity: 'warning',
      message: '拖尾条带：峰位下沿延展，给区间而非单点',
      location: { laneId: lane.laneId, bandId: band.bandId, y: band.center.y },
    });
  }
  if (segment.status === 'missing-span') {
    reasons.push('missing-span');
    status = 'interval';
    diagnostics.push({
      code: 'missing-ladder-band',
      severity: 'warning',
      message: '该段跨过 ladder 缺带，局部标尺只支持粗区间',
      location: { laneId: lane.laneId, bandId: band.bandId, segmentId: segment.segmentId, y: band.center.y },
    });
  }

  // 不确定度（px 弧长）映射为 bp 区间。
  const sigmaS = uncertaintyPx(band, segment.status === 'missing-span');
  const bpUpper = 10 ** (segment.intercept - segment.slope * (s - sigmaS));
  const bpLower = 10 ** (segment.intercept - segment.slope * (s + sigmaS));

  const baseCandidate: MwCandidate = {
    candidateId: stableId('cand', band.bandId, segment.segmentId, 'center', INFERENCE_PARAM_VERSION),
    bp: Math.round(bp),
    bpLabel: bpLabel(bp),
    segmentId: segment.segmentId,
    ladderBandIds: [segment.highBandId, segment.lowBandId],
    validRegion: { sMin: segment.sMin, sMax: segment.sMax, yMin: segment.yMin, yMax: segment.yMax },
    reason: reasons[0] ?? 'unique',
    bpLower: Math.round(Math.min(bpLower, bpUpper)),
    bpUpper: Math.round(Math.max(bpLower, bpUpper)),
  };

  const candidates: MwCandidate[] = [baseCandidate];

  // 重叠：为每个重叠邻居追加候选（取其中心的推断），保留全部合法候选。
  if (band.overlapsWith.length > 0) {
    // 邻居的弧长由外部传入更精确；这里用中心距近似 ±sigmaS 已覆盖，
    // 真正的邻居候选在 analyze 层用邻居 band 注入。
  }

  if (status === 'candidate-set' && !band.overlapsWith.length) {
    candidates.push({
      ...baseCandidate,
      candidateId: stableId('cand', band.bandId, segment.segmentId, 'lower', INFERENCE_PARAM_VERSION),
      bp: baseCandidate.bpLower!,
      bpLabel: `${bpLabel(baseCandidate.bpLower!)}（下界）`,
      reason: reasons[0] ?? 'saturated',
    });
    candidates.push({
      ...baseCandidate,
      candidateId: stableId('cand', band.bandId, segment.segmentId, 'upper', INFERENCE_PARAM_VERSION),
      bp: baseCandidate.bpUpper!,
      bpLabel: `${bpLabel(baseCandidate.bpUpper!)}（上界）`,
      reason: reasons[0] ?? 'saturated',
    });
  }

  if (segment.status === 'missing-span') status = status === 'unique' ? 'coarse' : status;

  return {
    inferenceId: stableId('mwinf', band.bandId, fit.fitId, INFERENCE_PARAM_VERSION),
    bandId: band.bandId,
    laneId: lane.laneId,
    status,
    candidates,
    diagnostics,
    paramVersion: `${INFERENCE_PARAM_VERSION}+${CALIBRATION_PARAM_VERSION}`,
    inputSummary: {
      arcLengthPx: Math.round(s * 100) / 100,
      curvaturePx: Math.round(curvatureSmile(lane) * 100) / 100,
      segmentStatus: segment.status,
      validRegion: baseCandidate.validRegion,
    },
    parentDepends: [band.bandId, lane.laneId, fit.fitId, segment.segmentId, segment.highBandId, segment.lowBandId],
  };
}

function uncertaintyPx(band: BandAnnotation, missingSpan: boolean): number {
  let u = 2;
  if (band.saturated) u += 6;
  if (band.tailed) u += 4;
  if (band.overlapsWith.length) u += 4;
  if (missingSpan) u += 10;
  return u;
}

function unresolved(
  band: BandAnnotation,
  diagnostics: Diagnostic[],
  s: number,
  fit: CalibrationFit,
): MwInference {
  return {
    inferenceId: stableId('mwinf', band.bandId, fit.fitId, INFERENCE_PARAM_VERSION, 'unresolved'),
    bandId: band.bandId,
    laneId: band.laneId,
    status: 'unresolved',
    candidates: [],
    diagnostics,
    paramVersion: `${INFERENCE_PARAM_VERSION}+${CALIBRATION_PARAM_VERSION}`,
    inputSummary: { arcLengthPx: Math.round(s * 100) / 100, validRegion: null },
    parentDepends: [band.bandId, band.laneId, fit.fitId],
  };
}

/** 输入完整性：缺材料/缺标注 → 带位置诊断，绝不伪装成功。 */
export function validateInput(input: GelInput): Diagnostic[] {
  const d: Diagnostic[] = [];
  if (!input.image) d.push({ code: 'incomplete-input', severity: 'error', message: '缺少原始图像材料' });
  if (!input.ladder) d.push({ code: 'incomplete-input', severity: 'error', message: '缺少 ladder 标称值材料' });
  if (input.lanes.length === 0)
    d.push({ code: 'incomplete-input', severity: 'error', message: '缺少 lane 边界标注' });
  if (input.bands.length === 0)
    d.push({ code: 'incomplete-input', severity: 'error', message: '缺少 band 中心标注' });
  for (const q of input.ladder?.nominals ?? []) {
    if (q.quantity.bp === null)
      d.push({
        code: 'unconvertible-unit',
        severity: 'error',
        message: `ladder 标称值 "${q.quantity.raw}" 无法规范化，保留原位`,
        location: { materialId: input.ladder?.materialId },
      });
  }
  for (const lane of input.lanes ?? []) {
    if (!lane.centerline?.points?.length)
      d.push({ code: 'incomplete-input', severity: 'error', message: `泳道 ${lane.label} 缺少中心线点列`, location: { laneId: lane.laneId } });
    if (!(lane.halfWidthPx > 0))
      d.push({ code: 'incomplete-input', severity: 'error', message: `泳道 ${lane.label} 缺少有效宽度`, location: { laneId: lane.laneId } });
  }
  for (const band of input.bands ?? []) {
    if (band.center.frame !== 'original-pixel')
      d.push({ code: 'incomplete-input', severity: 'error', message: `条带 ${band.bandId} 缺少原图像素坐标`, location: { bandId: band.bandId } });
    if (!input.lanes.some((l) => l.laneId === band.laneId))
      d.push({ code: 'incomplete-input', severity: 'error', message: `条带 ${band.bandId} 引用了不存在的泳道`, location: { bandId: band.bandId, laneId: band.laneId } });
  }
  return d;
}

/** 在弧形泳道上把邻居重叠条带的候选合并进来（保留全部合法候选）。 */
export function mergeOverlapCandidates(
  inferences: MwInference[],
  bands: BandAnnotation[],
  lanesById: Map<string, LaneAnnotation>,
  fits: Map<string, CalibrationFit>,
): MwInference[] {
  const infByBand = new Map(inferences.map((x) => [x.bandId, x]));
  return inferences.map((inf) => {
    const band = bands.find((b) => b.bandId === inf.bandId)!;
    if (!band.overlapsWith.length || inf.status === 'unresolved') return inf;
    const extras: MwCandidate[] = [];
    for (const neighborId of band.overlapsWith) {
      const neighbor = bands.find((b) => b.bandId === neighborId);
      const nInf = infByBand.get(neighborId);
      if (!neighbor || !nInf || nInf.status === 'unresolved') continue;
      for (const cand of nInf.candidates) {
        extras.push({
          ...cand,
          candidateId: stableId('cand', band.bandId, neighborId, cand.candidateId, INFERENCE_PARAM_VERSION),
          reason: 'overlap',
          bpLabel: `${cand.bpLabel}（重叠邻居 ${neighborId.slice(-5)}）`,
        });
      }
    }
    return extras.length
      ? { ...inf, status: 'candidate-set' as const, candidates: dedupeCandidates([...inf.candidates, ...extras]) }
      : inf;
  });
}

function dedupeCandidates(cands: MwCandidate[]): MwCandidate[] {
  const seen = new Set<string>();
  return cands.filter((c) => {
    const key = c.candidateId;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
