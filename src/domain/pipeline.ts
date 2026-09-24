import type { Diagnostic } from './units';
import type { Failure } from './result';
import type { BandCentersMaterial, LaneBoundariesMaterial, LadderMaterial } from './materials';
import { DEFAULT_ESTIMATE_PARAMS, estimateBand, type EstimateParams, type MwEstimate } from './estimates';
import type { DetectedBand } from './bands';
import {
  DEFAULT_RULER_PARAMS,
  anchorResiduals,
  buildLocalRulers,
  type AnchorPoint,
  type LaneGeom,
  type LocalRuler,
  type RulerParams,
} from './ruler';

/** Shared business rule: lanes + ladders + band centers -> local rulers -> MW estimates.
 *  Used identically by the server, the archive builder and the tests. */

export interface PipelineInput {
  lanes: LaneBoundariesMaterial;
  ladders: LadderMaterial[];
  bands: BandCentersMaterial[];
  estimateParams?: EstimateParams;
  rulerParams?: RulerParams;
}

export interface AnchorResidual {
  ref: string;
  bandIndex: number;
  residualPx: number;
}

export interface PipelineOutput {
  rulers: Record<string, LocalRuler>;
  estimates: MwEstimate[];
  failures: { bandKey: string; failure: Failure }[];
  diagnostics: Diagnostic[];
  residuals: AnchorResidual[];
  laneGeoms: LaneGeom[];
  anchorsByLadder: Record<string, AnchorPoint[]>;
}

export function laneGeomsFrom(lanes: LaneBoundariesMaterial): LaneGeom[] {
  return lanes.lanes.map((l) => ({
    laneId: l.laneId,
    xCenter: l.centerline.reduce((acc, p) => acc + p.x.value, 0) / l.centerline.length,
  }));
}

export function anchorsOf(ladder: LadderMaterial): AnchorPoint[] {
  return ladder.nominal
    .filter((b) => b.center)
    .map((b) => ({
      ref: `${ladder.id}#${b.bandIndex}`,
      bandIndex: b.bandIndex,
      bp: b.bp.value,
      yPx: b.center!.y.value,
    }));
}

export function runPipeline(input: PipelineInput): PipelineOutput {
  const estimateParams = input.estimateParams ?? DEFAULT_ESTIMATE_PARAMS;
  const rulerParams: RulerParams = input.rulerParams ?? {
    ...DEFAULT_RULER_PARAMS,
    smileCorrection: estimateParams.smileCorrection,
  };
  const diagnostics: Diagnostic[] = [];
  const failures: { bandKey: string; failure: Failure }[] = [];
  const geoms = laneGeomsFrom(input.lanes);
  const xOf = (laneId: string) => geoms.find((g) => g.laneId === laneId)?.xCenter ?? 0;
  const laddersSorted = [...input.ladders].sort((a, b) => xOf(a.laneId) - xOf(b.laneId));
  const ladderA = laddersSorted[0];
  const ladderB = laddersSorted.length > 1 ? laddersSorted[laddersSorted.length - 1] : null;
  if (!ladderA) {
    diagnostics.push({ code: 'no-ladder', message: '缺少 ladder 材料，无法建立标尺', severity: 'error' });
    return { rulers: {}, estimates: [], failures, diagnostics, residuals: [], laneGeoms: geoms, anchorsByLadder: {} };
  }
  const anchorsByLadder: Record<string, AnchorPoint[]> = {};
  for (const l of laddersSorted) anchorsByLadder[l.laneId] = anchorsOf(l);
  const rulerMap = buildLocalRulers({
    ladderA: { laneId: ladderA.laneId, xCenter: xOf(ladderA.laneId), anchors: anchorsByLadder[ladderA.laneId] },
    ladderB: ladderB
      ? { laneId: ladderB.laneId, xCenter: xOf(ladderB.laneId), anchors: anchorsByLadder[ladderB.laneId] }
      : null,
    lanes: geoms,
    params: rulerParams,
  });
  const rulers: Record<string, LocalRuler> = {};
  for (const [k, v] of rulerMap) {
    rulers[k] = v;
    diagnostics.push(...v.diagnostics);
  }
  const estimates: MwEstimate[] = [];
  for (const bandsMat of input.bands) {
    const ruler = rulers[bandsMat.laneId];
    if (!ruler) {
      diagnostics.push({
        code: 'no-ruler',
        message: `泳道 ${bandsMat.laneId} 没有局部标尺`,
        severity: 'error',
        position: { lane: bandsMat.laneId },
      });
      continue;
    }
    const detected: DetectedBand[] = bandsMat.centers.map((c) => ({
      bandKey: c.bandKey,
      laneId: bandsMat.laneId,
      xPx: c.center.x.value,
      yPx: c.center.y.value,
      peak: c.peakIntensity.value,
      widthPx: c.widthPx,
      upWidthPx: c.upWidthPx,
      downWidthPx: c.downWidthPx,
      flags: c.flags,
      ...(c.overlapGroup ? { overlapGroup: c.overlapGroup } : {}),
    }));
    for (const band of detected) {
      const group = band.overlapGroup ? detected.filter((d) => d.overlapGroup === band.overlapGroup) : [band];
      const { estimate, outcome, diagnostics: estDiags } = estimateBand(band, ruler, group, estimateParams);
      estimates.push(estimate);
      diagnostics.push(...estDiags);
      if (!outcome.ok) failures.push({ bandKey: band.bandKey, failure: outcome.failure });
    }
  }
  const residuals = anchorResiduals(anchorsByLadder[ladderA.laneId] ?? []);
  return { rulers, estimates, failures, diagnostics, residuals, laneGeoms: geoms, anchorsByLadder };
}
