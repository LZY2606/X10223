import type {
  AnalysisResult,
  BandCenterMaterial,
  BandInference,
  CalibrationParametersV1,
  CalibrationSegment,
  Diagnostic,
  InputSummary,
  LadderAnchor,
  LadderNominalMaterial,
  LaneBoundaryMaterial,
  MaterialRecord
} from '../shared/types.ts';
import { stableId } from './identity.ts';
import { projectBand } from './detection.ts';

export interface ComputeAnalysisInput {
  projectId: string;
  branchId: string;
  eventId: string;
  parameterHash: string;
  parameters: CalibrationParametersV1;
  materials: MaterialRecord[];
  inputSummary: InputSummary;
  createdAt: string;
}

function requiredMaterial<T extends MaterialRecord['material']['kind']>(
  materials: MaterialRecord[],
  kind: T
): Extract<MaterialRecord['material'], { kind: T }> {
  const record = materials.find((material) => material.material.kind === kind);
  if (!record) throw new Error(`missing required material ${kind}`);
  return record.material as Extract<MaterialRecord['material'], { kind: T }>;
}

function median(values: number[]): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function mean(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function globalFit(anchors: LadderAnchor[]): { slope: number; intercept: number; residuals: Map<string, number> } {
  const xs = anchors.map((anchor) => anchor.migrationPx);
  const ys = anchors.map((anchor) => Math.log10(anchor.molecularWeightBp));
  const xMean = mean(xs);
  const yMean = mean(ys);
  const denominator = xs.reduce((sum, x) => sum + (x - xMean) ** 2, 0);
  const slope = denominator === 0 ? 0 : xs.reduce((sum, x, index) => sum + (x - xMean) * (ys[index]! - yMean), 0) / denominator;
  const intercept = yMean - slope * xMean;
  const residuals = new Map<string, number>();
  anchors.forEach((anchor) => residuals.set(anchor.id, Math.log10(anchor.molecularWeightBp) - (slope * anchor.migrationPx + intercept)));
  return { slope, intercept, residuals };
}

function diagnostic(partial: Omit<Diagnostic, 'affectedObjectIds'> & { affectedObjectIds?: string[] }): Diagnostic {
  return { ...partial, affectedObjectIds: partial.affectedObjectIds ?? [] };
}

export function computeAnalysis(input: ComputeAnalysisInput): AnalysisResult {
  const nominal = requiredMaterial(input.materials, 'ladderNominal') as LadderNominalMaterial;
  const laneMaterial = requiredMaterial(input.materials, 'laneBoundary') as LaneBoundaryMaterial;
  const bandMaterial = requiredMaterial(input.materials, 'bandCenter') as BandCenterMaterial;
  const ladderLane = laneMaterial.lanes.find((lane) => lane.role === 'ladder');
  const diagnostics: Diagnostic[] = [];
  const outside = laneMaterial.lanes.filter((lane) => lane.center.points.some((point) =>
    point.x < 0 || point.y < 0 || point.x > input.inputSummary.pixelSize.width || point.y > input.inputSummary.pixelSize.height
  ));
  if (outside.length > 0) {
    diagnostics.push(diagnostic({
      code: 'ORIENTATION_AXIS_INVALID',
      severity: 'error',
      message: 'Lane geometry is outside the source pixel frame; rotate or re-register before inference.',
      position: { jsonPath: '$.laneBoundary.lanes' },
      affectedObjectIds: outside.map((lane) => lane.id)
    }));
    return emptyResult(input, diagnostics);
  }
  if (!ladderLane) {
    diagnostics.push(diagnostic({
      code: laneMaterial.lanes.length === 0 ? 'ORIENTATION_AXIS_INVALID' : 'INCOMPLETE_INPUT',
      severity: 'error',
      message: laneMaterial.lanes.length === 0 ? 'No lane axis can be located in the declared pixel frame.' : 'ladder lane is required',
      position: { jsonPath: '$.laneBoundary.lanes' },
      affectedObjectIds: laneMaterial.lanes.map((lane) => lane.id)
    }));
    return emptyResult(input, diagnostics);
  }

  const ladderBands = bandMaterial.bands.filter((band) => band.role === 'ladder').sort((left, right) => left.center.y - right.center.y);
  const nominalBands = nominal.bands;
  const gapThreshold = 1.55;
  const spacings = ladderBands.slice(1).map((band, index) => band.center.y - ladderBands[index]!.center.y);
  const normalSpacing = median(spacings.filter((spacing) => Number.isFinite(spacing)));
  const gapAfter = ladderBands.findIndex((band, index) => index > 0 && band.center.y - ladderBands[index - 1]!.center.y > normalSpacing * gapThreshold);
  let missingNominalId: string | undefined;
  const anchors: LadderAnchor[] = [];

  ladderBands.forEach((band, index) => {
    let nominalIndex = index;
    if (gapAfter > 0 && index >= gapAfter) {
      nominalIndex = index + 1;
      if (index === gapAfter) missingNominalId = nominalBands[gapAfter]?.id;
    }
    const nominalBand = nominalBands[nominalIndex];
    if (!nominalBand) return;
    const lane = laneMaterial.lanes.find((candidate) => candidate.id === band.laneId) ?? ladderLane;
    const projected = projectBand({ x: band.center.x, y: band.center.y }, lane);
    anchors.push({
      id: stableId('anchor', [nominalBand.id, band.id, projected.migration]),
      nominalBandId: nominalBand.id,
      molecularWeightBp: nominalBand.molecularWeight.value,
      migrationPx: projected.migration,
      sourceCenterPx: { x: band.center.x, y: band.center.y, frame: band.center.frame },
      residualLog10Bp: 0
    });
  });

  if (ladderBands.length < nominalBands.length || missingNominalId) {
    diagnostics.push(diagnostic({
      code: 'SEMANTIC_MISSING_LADDER_BAND',
      severity: 'structural',
      message: 'A ladder band is missing; adjacent bracket is not a unique ruler segment.',
      position: { laneId: ladderLane.id, bandId: missingNominalId },
      affectedObjectIds: missingNominalId ? [missingNominalId] : [ladderLane.id]
    }));
  }

  const fit = anchors.length >= 2 ? globalFit(anchors) : { slope: 0, intercept: 0, residuals: new Map<string, number>() };
  anchors.forEach((anchor) => { anchor.residualLog10Bp = fit.residuals.get(anchor.id) ?? 0; });

  const segments: CalibrationSegment[] = [];
  for (let index = 1; index < anchors.length; index += 1) {
    const previous = anchors[index - 1]!;
    const current = anchors[index]!;
    const logPrevious = Math.log10(previous.molecularWeightBp);
    const logCurrent = Math.log10(current.molecularWeightBp);
    const nonMonotonic = logCurrent >= logPrevious;
    const spansMissing = missingNominalId !== undefined && nominalBands.some((nominalBand) =>
      nominalBand.id === missingNominalId &&
      nominalBand.molecularWeight.value < previous.molecularWeightBp &&
      nominalBand.molecularWeight.value > current.molecularWeightBp
    );
    const slope = (logCurrent - logPrevious) / (current.migrationPx - previous.migrationPx || 1);
    segments.push({
      id: stableId('segment', [previous.id, current.id]),
      fromAnchorId: previous.id,
      toAnchorId: current.id,
      validMigrationRangePx: { start: previous.migrationPx, end: current.migrationPx, unit: 'px' },
      slopeLog10BpPerPx: slope,
      interceptLog10Bp: logPrevious - slope * previous.migrationPx,
      status: nonMonotonic ? 'invalid-non-monotonic' : spansMissing ? 'invalid-missing-anchor' : 'valid'
    });
    if (nonMonotonic) diagnostics.push(diagnostic({
      code: 'SEMANTIC_NON_MONOTONIC_RULER',
      severity: 'structural',
      message: 'Nominal ladder values are not monotonic along migration; this segment has no inverse.',
      position: { laneId: ladderLane.id },
      affectedObjectIds: [previous.nominalBandId, current.nominalBandId]
    }));
  }

  const bands: BandInference[] = [];
  for (const sourceBand of bandMaterial.bands.filter((band) => band.role === 'sample')) {
    const lane = laneMaterial.lanes.find((candidate) => candidate.id === sourceBand.laneId);
    if (!lane) continue;
    const projected = projectBand({ x: sourceBand.center.x, y: sourceBand.center.y }, lane);
    const segment = segments.find((candidate) =>
      candidate.status === 'valid' &&
      projected.migration >= candidate.validMigrationRangePx.start - input.parameters.maximumExtrapolation.value &&
      projected.migration <= candidate.validMigrationRangePx.end + input.parameters.maximumExtrapolation.value
    );
    const exactSegment = segments.find((candidate) =>
      candidate.status === 'valid' &&
      projected.migration >= candidate.validMigrationRangePx.start &&
      projected.migration <= candidate.validMigrationRangePx.end
    );
    const localDiagnostics: Diagnostic[] = [];
    const contour = sourceBand.contour ?? [{ x: sourceBand.center.x, y: sourceBand.center.y, intensity: 0 }];
    if (!exactSegment) {
      localDiagnostics.push(diagnostic({
        code: 'LOCAL_RULER_INVALID',
        severity: 'structural',
        message: 'No observed adjacent ladder bracket covers this migration under the current parameters.',
        position: { x: sourceBand.center.x, y: sourceBand.center.y, laneId: lane.id, bandId: sourceBand.id },
        affectedObjectIds: [sourceBand.id]
      }));
    }
    let bandStatus: BandInference['status'] = exactSegment ? 'accepted-unique' : 'locally-invalid';
    let molecularWeight: BandInference['molecularWeight'];
    let candidatesBp: number[] | undefined;
    if (exactSegment) {
      const value = Math.round(10 ** (exactSegment.slopeLog10BpPerPx * projected.migration + exactSegment.interceptLog10Bp));
      molecularWeight = { value, unit: 'bp' };
      if (sourceBand.observedAs === 'saturated-plateau') {
        bandStatus = 'candidate';
        localDiagnostics.push(diagnostic({
          code: 'SATURATED_BAND_CANDIDATE_ONLY',
          severity: 'warning',
          message: 'Saturated plateau has no unique center; molecular weight is a candidate with interval.',
          position: { x: sourceBand.center.x, y: sourceBand.center.y, laneId: lane.id, bandId: sourceBand.id },
          affectedObjectIds: [sourceBand.id]
        }));
        molecularWeight.intervalBp = [
          Math.round(10 ** (exactSegment.slopeLog10BpPerPx * (projected.migration - 8) + exactSegment.interceptLog10Bp)),
          Math.round(10 ** (exactSegment.slopeLog10BpPerPx * (projected.migration + 8) + exactSegment.interceptLog10Bp))
        ];
      }
      if (sourceBand.observedAs === 'tail') {
        bandStatus = 'candidate';
        localDiagnostics.push(diagnostic({
          code: 'TAIL_CANDIDATE_ONLY',
          severity: 'warning',
          message: 'Tailing leaves the apex and extent ambiguous; molecular weight remains a candidate.',
          position: { x: sourceBand.center.x, y: sourceBand.center.y, laneId: lane.id, bandId: sourceBand.id },
          affectedObjectIds: [sourceBand.id]
        }));
      }
      if (sourceBand.observedAs === 'overlap') {
        bandStatus = 'interval';
        candidatesBp = [value, Math.round(10 ** (exactSegment.slopeLog10BpPerPx * (projected.migration + 16) + exactSegment.interceptLog10Bp))];
        molecularWeight.intervalBp = [Math.min(...candidatesBp), Math.max(...candidatesBp)];
        localDiagnostics.push(diagnostic({
          code: 'OVERLAPPING_BANDS_RANGE_ONLY',
          severity: 'warning',
          message: 'Two overlapping bands cannot be uniquely assigned; all legal candidates are retained.',
          position: { x: sourceBand.center.x, y: sourceBand.center.y, laneId: lane.id, bandId: sourceBand.id },
          affectedObjectIds: [sourceBand.id]
        }));
      }
    }
    bands.push({
      id: stableId('inference', [sourceBand.id, input.parameterHash, laneMaterial.provenance, bandMaterial.provenance]),
      bandSourceId: sourceBand.id,
      laneId: lane.id,
      centerPx: { x: sourceBand.center.x, y: sourceBand.center.y, frame: sourceBand.center.frame },
      migrationPx: projected.migration,
      molecularWeight,
      candidatesBp,
      status: bandStatus,
      evidenceSegmentId: exactSegment?.id ?? segment?.id,
      contour,
      residualLog10Bp: exactSegment ? 0 : undefined,
      diagnostics: localDiagnostics
    });
  }

  const allDiagnostics = diagnostics.concat(bands.flatMap((band) => band.diagnostics));
  return {
    id: stableId('analysis', [input.eventId, input.parameterHash, input.inputSummary, laneMaterial.provenance, bandMaterial.provenance]),
    eventId: input.eventId,
    projectId: input.projectId,
    branchId: input.branchId,
    status: allDiagnostics.some((item) => item.severity === 'error') ? 'diagnostic-only' : 'complete',
    parametersHash: input.parameterHash,
    parameterVersion: input.parameters.version,
    inputSummary: input.inputSummary,
    parentDependencies: input.materials.map((material) => material.id),
    createdAt: input.createdAt,
    anchors,
    segments,
    bands,
    diagnostics: allDiagnostics,
    adopted: false
  };
}

function emptyResult(input: ComputeAnalysisInput, diagnostics: Diagnostic[]): AnalysisResult {
  return {
    id: stableId('analysis', [input.eventId, input.parameterHash]),
    eventId: input.eventId,
    projectId: input.projectId,
    branchId: input.branchId,
    status: 'diagnostic-only',
    parametersHash: input.parameterHash,
    parameterVersion: input.parameters.version,
    inputSummary: input.inputSummary,
    parentDependencies: input.materials.map((material) => material.id),
    createdAt: input.createdAt,
    anchors: [],
    segments: [],
    bands: [],
    diagnostics,
    adopted: false
  };
}
