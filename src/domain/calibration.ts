import { IncompleteInputDiagnostics } from './errors.js';
import { orientedLaneCurve, projectToCurve, rotateRawPoint, pxQuantity } from './geometry.js';
import { stableHash, stableId } from './ids.js';
import type {
  BandMaterial,
  CalibrationParams,
  CalibrationSegment,
  EvidenceEvent,
  ExposureMaterial,
  ImageMaterial,
  LadderMaterial,
  LaneCurve,
  LaneMaterial,
  MolecularWeightCandidate,
  OrientationMaterial,
  ComputationRecord,
  Diagnostic
} from './types.js';

export interface CalibrationInputs {
  image: ImageMaterial;
  orientation: OrientationMaterial;
  exposure: ExposureMaterial;
  ladder: LadderMaterial;
  lanes: LaneMaterial[];
  bands: BandMaterial[];
  params: CalibrationParams;
}

interface LadderAnchor {
  nominalId: string;
  label: string;
  bp: number;
  s: number;
  present: boolean;
  band?: BandMaterial;
}

export function inferMolecularWeights(inputs: CalibrationInputs, createdAt = new Date(0).toISOString()): ComputationRecord {
  const diagnostics = validateInputs(inputs);
  if (diagnostics.length) throw new IncompleteInputDiagnostics(diagnostics);

  const curveByLane = new Map<string, LaneCurve>();
  for (const lane of inputs.lanes) {
    curveByLane.set(lane.subjectId, orientedLaneCurve(lane, inputs.orientation, inputs.image.width, inputs.image.height));
  }
  const ladderLane = inputs.lanes.find((lane) => lane.subjectId === inputs.ladder.laneSubjectId);
  if (!ladderLane) {
    throw new IncompleteInputDiagnostics([
      { code: 'INCOMPLETE_INPUT', path: 'ladder.laneSubjectId', message: 'Ladder references a lane that is absent' }
    ]);
  }
  const ladderCurve = curveByLane.get(ladderLane.subjectId)!;
  const ladderBands = inputs.bands.filter((band) => band.laneSubjectId === ladderLane.subjectId);
  const anchors = buildAnchors(inputs.ladder, ladderBands, ladderCurve, inputs.orientation, inputs.image.width, inputs.image.height);
  const segments = buildSegments(anchors);
  const candidates = inputs.bands
    .filter((band) => band.laneSubjectId !== ladderLane.subjectId)
    .map((band) => inferBand(band, curveByLane.get(band.laneSubjectId)!, segments, inputs));

  const inputSummary = {
    image: `${inputs.image.id}@${inputs.image.version} sha256:${inputs.image.sha256.slice(0, 16)}`,
    orientation: `${inputs.orientation.id}@${inputs.orientation.version} rotation=${inputs.orientation.rotationDeg}`,
    exposure: `${inputs.exposure.id}@${inputs.exposure.version} saturation=${inputs.exposure.saturationLevel.value}`,
    ladder: `${inputs.ladder.id}@${inputs.ladder.version} nominal=${inputs.ladder.nominalBands.length}`,
    lanes: inputs.lanes.map((lane) => `${lane.subjectId}@${lane.version}`).join(','),
    bands: inputs.bands.map((band) => `${band.subjectId}@${band.version}`).join(','),
    params: `${inputs.params.schema}@${inputs.params.version}`
  };
  const parentDependencyIds = [
    inputs.image.id,
    inputs.orientation.id,
    inputs.exposure.id,
    inputs.ladder.id,
    ...inputs.lanes.map((lane) => lane.id),
    ...inputs.bands.map((band) => band.id),
    stableId('params', [inputs.params])
  ];
  return {
    id: stableId('calc', [inputSummary, candidates, segments, inputs.params.version]),
    kind: 'molecular-weight-inference',
    ruleVersion: 'gel-rules-2026.1',
    parameterVersion: inputs.params.version,
    inputSummary,
    parentDependencyIds,
    candidates,
    segments,
    laneCurves: [...curveByLane.values()],
    createdAt
  };
}

function validateInputs(inputs: CalibrationInputs): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const add = (path: string, message: string) =>
    diagnostics.push({ code: 'INCOMPLETE_INPUT', path, message });
  if (!inputs.image.pixelsBase64) add('image.pixelsBase64', 'Original pixels are required');
  if (inputs.image.width <= 0 || inputs.image.height <= 0) add('image.dimensions', 'Image dimensions must be positive');
  if (inputs.exposure.saturationLevel.value <= 0) add('exposure.saturationLevel', 'Saturation level is required');
  if (!inputs.ladder.nominalBands.length) add('ladder.nominalBands', 'Ladder requires nominal bands');
  if (inputs.lanes.some((lane) => lane.left.length < 2 || lane.right.length < 2)) add('lanes', 'Lane boundaries need at least two pixel points');
  for (const band of inputs.bands) {
    if (!Number.isFinite(band.center.x) || !Number.isFinite(band.center.y)) {
      diagnostics.push({ code: 'INCOMPLETE_INPUT', path: `bands.${band.id}.center`, message: 'Band center pixel is missing', position: band.center });
    }
  }
  return diagnostics;
}

function buildAnchors(
  ladder: LadderMaterial,
  bands: BandMaterial[],
  curve: LaneCurve,
  orientation: OrientationMaterial,
  rawWidth: number,
  rawHeight: number
): LadderAnchor[] {
  return ladder.nominalBands
    .slice()
    .sort((a, b) => a.order - b.order)
    .map((nominal) => {
      const band = bands.find((candidate) => candidate.label === nominal.label || candidate.subjectId.endsWith(`-${nominal.id}`));
      const orientedCenter = band ? rotateRawPoint(band.center, orientation, rawWidth, rawHeight) : undefined;
      return {
        nominalId: nominal.id,
        label: nominal.label,
        bp: nominal.molecularWeight.value,
        s: band && orientedCenter ? projectToCurve(orientedCenter, curve).arcLength : Number.NaN,
        present: Boolean(band),
        band
      };
    });
}

function buildSegments(anchors: LadderAnchor[]): CalibrationSegment[] {
  const segments: CalibrationSegment[] = [];
  for (let index = 0; index < anchors.length - 1; index += 1) {
    const upper = anchors[index];
    const lower = anchors[index + 1];
    const events: EvidenceEvent[] = [];
    let status: CalibrationSegment['status'] = 'direct';
    let valid = true;
    if (!upper.present || !lower.present) {
      status = 'missing-anchor-gap';
      valid = false;
      events.push({
        ruleId: 'missing-ladder-gap',
        severity: 'warning',
        reasonCode: 'LADDER_BAND_MISSING',
        message: '缺带导致相邻插值段无直接 ladder 锚点，只允许区间或候选。',
        affectedObjectIds: [upper.nominalId, lower.nominalId]
      });
    } else if (!(upper.s < lower.s)) {
      status = 'nonmonotonic';
      valid = false;
      events.push({
        ruleId: 'nonmonotonic-ruler-invalid',
        severity: 'error',
        reasonCode: 'RULER_NOT_MONOTONIC',
        message: '标称分子量与迁移弧长不满足单调关系，该插值段失效。',
        affectedObjectIds: [upper.nominalId, lower.nominalId]
      });
    } else if (!(upper.bp > lower.bp)) {
      status = 'nonmonotonic';
      valid = false;
      events.push({
        ruleId: 'nonmonotonic-ruler-invalid',
        severity: 'error',
        reasonCode: 'NOMINAL_NOT_MONOTONIC',
        message: 'ladder 标称值顺序非单调，不能建立局部标尺。',
        affectedObjectIds: [upper.nominalId, lower.nominalId]
      });
    }
    const sStart = valid ? upper.s : Number.NaN;
    const sEnd = valid ? lower.s : Number.NaN;
    events.push({
      ruleId: 'smile-local-calibration',
      severity: 'info',
      reasonCode: 'LOCAL_LANE_REGION',
      message: '微笑弯曲时以该泳道曲线弧长定义分子量，局部标尺仅在相邻 ladder 点之间有效。',
      affectedObjectIds: [upper.nominalId, lower.nominalId],
      validRegion: { laneSubjectId: '', sStart: sStart || 0, sEnd: sEnd || 0, unit: 'px', basis: 'observed-ladder-anchors' }
    });
    segments.push({
      id: stableId('segment', [upper.nominalId, lower.nominalId, upper.s, lower.s, upper.bp, lower.bp, valid]),
      lowerBandId: lower.nominalId,
      upperBandId: upper.nominalId,
      sStart,
      sEnd,
      startBp: upper.bp,
      endBp: lower.bp,
      valid,
      status,
      evidence: events
    });
  }
  return segments;
}

function inferBand(
  band: BandMaterial,
  curve: LaneCurve,
  ladderSegments: CalibrationSegment[],
  inputs: CalibrationInputs
): MolecularWeightCandidate {
  const orientedCenter = rotateRawPoint(band.center, inputs.orientation, inputs.image.width, inputs.image.height);
  const projection = projectToCurve(orientedCenter, curve);
  const evidence: EvidenceEvent[] = [
    {
      ruleId: 'smile-local-calibration',
      severity: 'info',
      reasonCode: 'CURVE_ARC_LENGTH',
      message: '条带位置投影到弯曲泳道中心线；同一图像高度不等于同一分子量。',
      affectedObjectIds: [band.subjectId],
      validRegion: {
        laneSubjectId: band.laneSubjectId,
        sStart: projection.arcLength - Math.abs(projection.lateralResidualPx),
        sEnd: projection.arcLength + Math.abs(projection.lateralResidualPx),
        unit: 'px',
        basis: 'observed-ladder-anchors'
      },
      position: band.center
    }
  ];
  const diagnostics: Diagnostic[] = [];
  if (Math.abs(projection.lateralResidualPx) > inputs.params.maxLateralResidualPx) {
    evidence.push({
      ruleId: 'outside-valid-region',
      severity: 'warning',
      reasonCode: 'LATERAL_RESIDUAL_TOO_LARGE',
      message: '条带中心偏离修订后的泳道曲线有效区域。',
      affectedObjectIds: [band.subjectId],
      position: band.center
    });
  }
  const segment = ladderSegments.find((candidate) => candidate.valid && projection.arcLength >= candidate.sStart && projection.arcLength <= candidate.sEnd);
  const overlaps = findOverlaps(band, inputs.bands, inputs.params.overlapRadiusFactor);
  if (overlaps.length) {
    evidence.push({
      ruleId: 'overlap-all-candidates',
      severity: 'warning',
      reasonCode: 'OVERLAPPING_BANDS',
      message: '两条带空间轮廓重叠，无法唯一决定时保留全部合法候选。',
      affectedObjectIds: [band.subjectId, ...overlaps]
    });
  }
  if (band.observation.saturated || band.observation.intensity >= inputs.exposure.saturationLevel.value) {
    evidence.push({
      ruleId: 'saturated-candidate-interval',
      severity: 'warning',
      reasonCode: 'SATURATED_PEAK',
      message: '饱和条带中心被积分平台污染，只能标为候选或区间。',
      affectedObjectIds: [band.subjectId],
      position: band.center
    });
  }
  const tailAsymmetry = band.observation.trailingEdgePx - band.observation.leadingEdgePx;
  if (tailAsymmetry >= inputs.params.tailAsymmetryThreshold) {
    evidence.push({
      ruleId: 'tailing-candidate-interval',
      severity: 'warning',
      reasonCode: 'TAILING_ASYMMETRY',
      message: '拖尾轮廓给出非对称边缘，分子量只能作为候选或区间。',
      affectedObjectIds: [band.subjectId],
      position: band.center
    });
  }
  const ambiguous = evidence.some((event) =>
    event.ruleId === 'overlap-all-candidates' ||
    event.ruleId === 'saturated-candidate-interval' ||
    event.ruleId === 'tailing-candidate-interval'
  );
  if (!segment) {
    diagnostics.push({ code: 'OUT_OF_VALID_REGION', path: `bands.${band.id}.center`, message: 'Band lies outside direct ladder interpolation region', position: band.center });
    evidence.push({
      ruleId: 'outside-valid-region',
      severity: 'error',
      reasonCode: 'NO_INTERPOLATION_SEGMENT',
      message: '没有覆盖该弧长的有效 ladder 插值段。',
      affectedObjectIds: [band.subjectId],
      position: band.center
    });
  } else if (!segment.valid) {
    evidence.push(...segment.evidence.filter((event) => event.ruleId !== 'smile-local-calibration'));
  }
  const valueBp = segment?.valid ? interpolateLogBp(segment, projection.arcLength) : undefined;
  const intervalBp = makeInterval(segment, valueBp);
  const status: MolecularWeightCandidate['status'] = !segment
    ? 'invalid'
    : ambiguous
      ? 'candidate'
      : 'unique';
  const primary: MolecularWeightCandidate = {
    id: stableId('mw', [band.id, segment?.id ?? 'outside', valueBp, status, inputs.params.version]),
    bandSubjectId: band.subjectId,
    laneSubjectId: band.laneSubjectId,
    valueBp: !ambiguous ? valueBp : undefined,
    intervalBp: ambiguous ? intervalBp : undefined,
    status,
    migrationS: { value: projection.arcLength, unit: 'px', origin: 'lane-curve-origin' },
    lateralResidual: pxQuantity(projection.lateralResidualPx),
    segmentId: segment?.id,
    evidence,
    diagnostics,
    alternatives: []
  };
  if (overlaps.length && segment?.valid) {
    primary.alternatives = overlaps.map((subjectId, index) => ({
      ...primary,
      id: stableId('mw-alt', [primary.id, subjectId, index]),
      bandSubjectId: subjectId,
      status: 'candidate',
      valueBp: undefined,
      intervalBp: { min: segment.endBp, max: segment.startBp },
      alternatives: []
    }));
  }
  return primary;
}

function findOverlaps(band: BandMaterial, allBands: BandMaterial[], factor: number): string[] {
  return allBands
    .filter((candidate) => candidate.laneSubjectId === band.laneSubjectId && candidate.id !== band.id)
    .filter((candidate) => {
      const distance = Math.hypot(candidate.center.x - band.center.x, candidate.center.y - band.center.y);
      return distance <= (band.observation.radiusPx + candidate.observation.radiusPx) * factor;
    })
    .map((candidate) => candidate.subjectId);
}

function interpolateLogBp(segment: CalibrationSegment, s: number): number {
  const t = (s - segment.sStart) / (segment.sEnd - segment.sStart);
  return Math.exp(Math.log(segment.startBp) + t * (Math.log(segment.endBp) - Math.log(segment.startBp)));
}

function makeInterval(segment: CalibrationSegment | undefined, valueBp: number | undefined): { min: number; max: number } | undefined {
  if (!segment || !segment.valid) return segment ? { min: Math.min(segment.endBp, segment.startBp), max: Math.max(segment.endBp, segment.startBp) } : undefined;
  if (valueBp === undefined) return { min: segment.endBp, max: segment.startBp };
  const spread = Math.max(0.01 * valueBp, 1);
  return { min: Math.max(segment.endBp, valueBp - spread), max: Math.min(segment.startBp, valueBp + spread) };
}
