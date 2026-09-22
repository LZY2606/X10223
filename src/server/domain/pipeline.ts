import { Diagnostic, Outcome, normalizeBp } from '../../shared/quantity';
import { digestOf } from '../../shared/canonical';
import { fitScale, mwAt, LadderPoint, ScaleParams, ScaleFit, MwEstimate } from './scale';
import { correctedY, LaneRecord } from './lanes';
import { assessBand, detectOverlaps, BandEvidence, BandParams, OverlapGroup } from './bands';

export interface AnalysisParams {
  scale: ScaleParams;
  band: BandParams;
}

export interface LadderEntity {
  ladderId: string;
  name: string;
  nominal: { bandId: string; size: import('../../shared/quantity').Quantity }[]; // raw representation kept
  detected: { bandId: string; yPx: number }[]; // image-px detection in ladder lane
}

export interface ImageMeta {
  imageId: string;
  sha256: string;
  width: number;
  height: number;
  orientation: string; // e.g. 'wells-top' | 'rotated-90cw'
  exposure: { value: number; unit: 'ms' };
}

export interface PipelineInput {
  image: ImageMeta;
  ladder: LadderEntity;
  lanes: LaneRecord[];
  bands: BandEvidence[];
  params: AnalysisParams;
}

export interface DerivedResult {
  kind: 'ladder-consistency' | 'scale-fit' | 'band-mw';
  subjectId: string;
  payload: Record<string, unknown>;
  inputDigest: string;
  paramsVersion: string;
  parents: string[]; // entity ids this result depends on
}

export interface BandMwPayload {
  bandId: string;
  laneId: string;
  imageY: number;
  correctedY: number;
  coordinateBasis: 'datum-corrected-image-px';
  estimate: MwEstimate | null;
  verdict: 'decisive' | 'candidate-only' | 'unavailable';
  validityRegion: { yMin: number; yMax: number } | null;
  provenance: {
    ladderPointIds: string[];
    segment: { bandId0: string; bandId1: string; index: number } | null;
    laneCurveId: string;
    pixelSource: BandEvidence['pixelSource'];
  } | null;
  overlap: { groupId: string; candidates: OverlapGroup['candidates'] } | null;
  diagnostics: Diagnostic[];
}

export function computeResults(input: PipelineInput): DerivedResult[] {
  const results: DerivedResult[] = [];
  const paramsVersion = `${input.params.scale.version}/${input.params.band.version}`;
  const ladderLane = input.lanes.find((l) => l.role === 'ladder');
  if (!ladderLane) {
    results.push({
      kind: 'scale-fit',
      subjectId: input.ladder.ladderId,
      payload: { status: 'failed', failure: 'SEMANTIC_UNSOLVABLE', diagnostics: [{ code: 'NO_LADDER_LANE', message: 'no ladder lane annotated', position: '$.lanes', severity: 'error' }] },
      inputDigest: digestOf({ ladder: input.ladder, lanes: input.lanes.map((l) => l.laneId) }),
      paramsVersion,
      parents: [input.ladder.ladderId, input.image.imageId],
    });
    return results;
  }

  // 1. ladder consistency: nominal sizes vs detected bands (missing bands diagnosed, fit proceeds partial)
  const detectedByBand = new Map(input.ladder.detected.map((d) => [d.bandId, d.yPx]));
  const consistencyDiags: Diagnostic[] = [];
  const points: LadderPoint[] = [];
  input.ladder.nominal.forEach((n, i) => {
    const pos = `$.ladder.nominal[${i}](bandId=${n.bandId})`;
    const conv = normalizeBp(n.size, pos);
    if (conv.diagnostic) {
      consistencyDiags.push(conv.diagnostic);
      return; // unconvertible value stays in place, excluded from fit
    }
    const yPx = detectedByBand.get(n.bandId);
    if (yPx === undefined) {
      consistencyDiags.push({
        code: 'MISSING_LADDER_BAND',
        message: `nominal ladder band ${n.bandId} (${conv.value}bp) has no detected pixel position; fit proceeds without it`,
        position: pos,
        severity: 'warning',
      });
      return;
    }
    points.push({ bandId: n.bandId, yPx: correctedY(ladderLane.curve, ladderLane.curve, ladderLane.curve.xRef, ladderLane.curve.xRef, yPx), sizeBp: conv.value! });
  });
  results.push({
    kind: 'ladder-consistency',
    subjectId: input.ladder.ladderId,
    payload: {
      status: consistencyDiags.some((d) => d.severity === 'error') ? 'error' : consistencyDiags.length > 0 ? 'partial' : 'ok',
      nominalCount: input.ladder.nominal.length,
      detectedCount: points.length,
      diagnostics: consistencyDiags,
    },
    inputDigest: digestOf({ nominal: input.ladder.nominal, detected: input.ladder.detected }),
    paramsVersion,
    parents: [input.ladder.ladderId, input.image.imageId],
  });

  // 2. scale fit
  const fitOutcome: Outcome<ScaleFit> = fitScale(points, input.params.scale);
  const scaleParents = [input.ladder.ladderId, ladderLane.laneId, input.image.imageId];
  if (fitOutcome.status === 'failed') {
    results.push({
      kind: 'scale-fit',
      subjectId: input.ladder.ladderId,
      payload: { status: 'failed', failure: fitOutcome.failure, diagnostics: fitOutcome.diagnostics },
      inputDigest: digestOf({ points }),
      paramsVersion,
      parents: scaleParents,
    });
    for (const band of input.bands) {
      results.push(bandUnavailable(band, fitOutcome.failure, fitOutcome.diagnostics, paramsVersion, input));
    }
    return results;
  }
  const fit = fitOutcome.value;
  results.push({
    kind: 'scale-fit',
    subjectId: input.ladder.ladderId,
    payload: {
      status: 'ok',
      validity: fit.validity,
      segments: fit.segments,
      residuals: fit.residuals,
      slope: fit.slope,
      intercept: fit.intercept,
      usedBandIds: fit.usedBandIds,
      diagnostics: fitOutcome.diagnostics,
    },
    inputDigest: digestOf({ points }),
    paramsVersion,
    parents: scaleParents,
  });

  // 3. per-band molecular weight with full provenance
  const overlaps = detectOverlaps(input.bands, input.params.band);
  const overlapByBand = new Map<string, OverlapGroup>();
  for (const g of overlaps) for (const id of g.memberBandIds) overlapByBand.set(id, g);
  const laneById = new Map(input.lanes.map((l) => [l.laneId, l]));

  for (const band of input.bands) {
    const lane = laneById.get(band.laneId);
    const diagnostics: Diagnostic[] = [];
    if (!lane) {
      results.push(bandUnavailable(band, 'SEMANTIC_UNSOLVABLE', [{ code: 'NO_LANE', message: `band ${band.bandId} references missing lane ${band.laneId}`, position: `$.bands[bandId=${band.bandId}].laneId`, severity: 'error' }], paramsVersion, input));
      continue;
    }
    const assessment = assessBand(band, input.params.band);
    diagnostics.push(...assessment.reasons);
    const overlap = overlapByBand.get(band.bandId) ?? null;
    if (overlap) diagnostics.push(overlap.diagnostic);
    const yCorr = correctedY(lane.curve, ladderLane.curve, ladderLane.curve.xRef, band.centerX, band.centerY);
    const estimate = mwAt(fit, yCorr);
    let verdict: BandMwPayload['verdict'] = assessment.verdict;
    if (overlap) verdict = 'candidate-only';
    if (estimate.type === 'interval') {
      diagnostics.push({
        code: 'OUTSIDE_VALIDITY_REGION',
        message: `band ${band.bandId} corrected y=${yCorr.toFixed(1)}px is ${estimate.side} the local ruler validity region [${fit.validity.yMin.toFixed(1)}, ${fit.validity.yMax.toFixed(1)}]px; interval bound only`,
        position: `$.bands[bandId=${band.bandId}].centerY`,
        severity: 'warning',
      });
      if (verdict === 'decisive') verdict = 'candidate-only';
    }
    const segment = estimate.type === 'value' ? estimate.segment : null;
    const payload: BandMwPayload = {
      bandId: band.bandId,
      laneId: band.laneId,
      imageY: band.centerY,
      correctedY: yCorr,
      coordinateBasis: 'datum-corrected-image-px',
      estimate,
      verdict,
      validityRegion: fit.validity,
      provenance: {
        ladderPointIds: fit.usedBandIds,
        segment: segment ? { bandId0: segment.bandId0, bandId1: segment.bandId1, index: segment.index } : null,
        laneCurveId: lane.curve.laneId,
        pixelSource: band.pixelSource,
      },
      overlap: overlap ? { groupId: overlap.groupId, candidates: overlap.candidates } : null,
      diagnostics,
    };
    results.push({
      kind: 'band-mw',
      subjectId: band.bandId,
      payload: payload as unknown as Record<string, unknown>,
      inputDigest: digestOf({ band, laneCurve: lane.curve, points }),
      paramsVersion,
      parents: [band.bandId, band.laneId, input.ladder.ladderId, input.image.imageId],
    });
  }
  return results;
}

function bandUnavailable(
  band: BandEvidence,
  failure: string,
  diagnostics: Diagnostic[],
  paramsVersion: string,
  input: PipelineInput,
): DerivedResult {
  const payload: BandMwPayload = {
    bandId: band.bandId,
    laneId: band.laneId,
    imageY: band.centerY,
    correctedY: NaN,
    coordinateBasis: 'datum-corrected-image-px',
    estimate: null,
    verdict: 'unavailable',
    validityRegion: null,
    provenance: null,
    overlap: null,
    diagnostics: [...diagnostics, { code: 'UPSTREAM_FAILED', message: `scale fit unavailable (${failure}); molecular weight not computed`, position: `$.bands[bandId=${band.bandId}]`, severity: 'error' }],
  };
  return {
    kind: 'band-mw',
    subjectId: band.bandId,
    payload: payload as unknown as Record<string, unknown>,
    inputDigest: digestOf({ band, failure }),
    paramsVersion,
    parents: [band.bandId, band.laneId, input.ladder.ladderId, input.image.imageId],
  };
}
