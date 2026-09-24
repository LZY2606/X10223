import { digest, resultId } from './ids.ts';
import { diag, type Diagnostic } from './units.ts';
import {
  type BandCenter,
  type DerivedResult,
  type Judgement,
  type LaneBoundary,
  type LadderNominal,
  type Material,
  type Outcome,
  type ParamSet,
} from './types.ts';
import {
  buildLaneCurves,
  buildLocalRuler,
  groupOverlaps,
  inferMw,
  type LaneCurve,
  type LocalRuler,
  type MwEstimate,
} from './gel.ts';

export interface ImageAccess {
  width: number;
  height: number;
  intensityAt(x: number, y: number): number;
}

export interface PipelineResult {
  outcome: Outcome;
  results: DerivedResult[];
  judgements: Judgement[];
  diagnostics: Diagnostic[];
}

function latestByKind(materials: Material[], kind: string, labelPrefix?: string): Material[] {
  const matches = materials.filter((m) => m.kind === kind && (!labelPrefix || m.label.startsWith(labelPrefix)));
  const byLabel = new Map<string, Material>();
  for (const m of matches) {
    const prev = byLabel.get(m.label);
    if (!prev || m.seq > prev.seq) byLabel.set(m.label, m);
  }
  return [...byLabel.values()].sort((a, b) => a.label.localeCompare(b.label));
}

/** The full computation pipeline. Pure and deterministic: equivalent
 *  inputs yield identical result ids and stable ordering. Never fakes
 *  success — incomplete input returns positioned diagnostics. */
export function runPipeline(
  materials: Material[],
  params: ParamSet,
  image?: ImageAccess,
  branch = 'main',
): PipelineResult {
  const diagnostics: Diagnostic[] = [];
  const judgements: Judgement[] = [];
  const results: DerivedResult[] = [];

  const imageMat = latestByKind(materials, 'gel_image')[0];
  const orientationMat = latestByKind(materials, 'capture_orientation')[0];
  const exposureMat = latestByKind(materials, 'exposure')[0];
  const ladderMat = latestByKind(materials, 'ladder_nominal')[0];
  const lanesMat = latestByKind(materials, 'lane_boundary')[0];
  const bandMats = latestByKind(materials, 'band_centers');

  // --- input completeness: positioned diagnostics, no null fakery -------
  const required: [string, Material | undefined][] = [
    ['materials.gel_image', imageMat],
    ['materials.capture_orientation', orientationMat],
    ['materials.exposure', exposureMat],
    ['materials.ladder_nominal', ladderMat],
    ['materials.lane_boundary', lanesMat],
  ];
  let incomplete = false;
  for (const [path, mat] of required) {
    if (!mat) {
      diagnostics.push(diag(path, 'INPUT_MISSING', `required material missing: ${path}`));
      incomplete = true;
    }
  }
  if (bandMats.length === 0) {
    diagnostics.push(diag('materials.band_centers', 'INPUT_MISSING', 'no band_centers materials imported'));
    incomplete = true;
  }
  if (incomplete) {
    return { outcome: { kind: 'semantically_unsolvable', diagnostics }, results, judgements, diagnostics };
  }

  const lanes = (lanesMat!.raw as { lanes: LaneBoundary[] }).lanes;
  const ladder = ladderMat!.raw as LadderNominal;
  const imageRaw = imageMat!.raw as { width: number; height: number; smile_k?: number };
  const smileK = imageRaw.smile_k ?? 0;
  const orientation = orientationMat!.raw as { rotation_deg: number; wells: string };
  const flipY = orientation.wells === 'bottom';
  const normalizeY = (y: number): number => (flipY ? imageRaw.height - 1 - y : y);

  // --- resource budget: a distinct outcome when exhausted ---------------
  let budget = params.solver_budget;
  const spend = (n: number, where: string): boolean => {
    budget -= n;
    if (budget < 0) {
      diagnostics.push(diag(where, 'BUDGET_EXHAUSTED', `solver budget ${params.solver_budget} exhausted at ${where}`));
      return false;
    }
    return true;
  };

  const curves = buildLaneCurves(lanes, smileK, imageRaw.width, imageRaw.height);
  const curveByLane = new Map<number, LaneCurve>(curves.map((c) => [c.lane_index, c]));

  // lane_curve results
  for (const curve of curves) {
    if (!spend(1, `lane_curve[${curve.lane_index}]`)) {
      return { outcome: { kind: 'budget_exhausted', diagnostics }, results, judgements, diagnostics };
    }
    const parents = [lanesMat!.id, imageMat!.id, orientationMat!.id];
    results.push({
      id: resultId('lane_curve', digest(curve), params.version, parents),
      kind: 'lane_curve',
      status: 'ok',
      input_digest: digest(curve),
      params_version: params.version,
      parents,
      branch,
      seq: 0,
      value: { ...curve, unit: 'px', basis: 'image/top-left/+y-down' },
    });
  }

  // --- rulers: ladder lane provides the calibration points --------------
  const ladderLaneIdx = lanes.find((l) => l.role === 'ladder')?.lane_index;
  if (ladderLaneIdx === undefined) {
    diagnostics.push(diag('lane_boundary.lanes', 'LADDER_LANE_MISSING', 'no lane with role=ladder'));
    return { outcome: { kind: 'semantically_unsolvable', diagnostics }, results, judgements, diagnostics };
  }

  const bandsByLane = new Map<number, BandCenter[]>();
  const bandMatByLane = new Map<number, Material>();
  for (const m of bandMats) {
    const laneIdx = Number(m.label.split('-')[1]);
    const centers = (m.raw as { centers: BandCenter[] }).centers;
    bandsByLane.set(laneIdx, centers);
    bandMatByLane.set(laneIdx, m);
  }

  const ladderBands = bandsByLane.get(ladderLaneIdx) ?? [];
  const rulerByLane = new Map<number, LocalRuler>();

  for (const curve of curves) {
    if (!spend(2, `ruler[${curve.lane_index}]`)) {
      return { outcome: { kind: 'budget_exhausted', diagnostics }, results, judgements, diagnostics };
    }
    const ladderPoints = ladderBands.map((b) => {
      const size = (b as BandCenter & { size_bp?: number }).size_bp;
      return { y: normalizeY(b.y), size_bp: size ?? 0, id: b.band_id };
    }).filter((p) => p.size_bp > 0);
    const ladderLaneOffset = curveByLane.get(ladderLaneIdx)!.smile_offset_px;
    const built = buildLocalRuler({
      lane: curve,
      ladderLaneOffsetPx: ladderLaneOffset,
      ladderPoints,
      nominalSizesBp: ladder.sizes_bp,
      params,
    });
    judgements.push(...built.judgements);
    const parents = [ladderMat!.id, lanesMat!.id, imageMat!.id, bandMatByLane.get(ladderLaneIdx)?.id ?? 'missing'];
    if (built.outcome.kind !== 'ok') {
      for (const d of built.outcome.diagnostics) diagnostics.push(d);
      results.push({
        id: resultId('ruler', digest({ lane: curve.lane_index, fail: built.outcome.diagnostics }), params.version, parents),
        kind: 'ruler',
        status: 'invalid',
        input_digest: digest({ lane: curve.lane_index }),
        params_version: params.version,
        parents,
        branch,
        seq: 0,
        value: { lane_index: curve.lane_index, outcome: built.outcome.kind, diagnostics: built.outcome.diagnostics },
      });
      if (curve.lane_index === ladderLaneIdx) {
        // The ladder lane's own ruler failing makes calibration impossible.
        return { outcome: built.outcome, results, judgements, diagnostics };
      }
      continue;
    }
    const ruler = built.ruler!;
    rulerByLane.set(curve.lane_index, ruler);
    results.push({
      id: resultId('ruler', digest(ruler), params.version, parents),
      kind: 'ruler',
      status: 'ok',
      input_digest: digest(ruler),
      params_version: params.version,
      parents,
      branch,
      seq: 0,
      value: ruler,
    });
    // fit residuals as first-class results so the review page can overlay them
    results.push({
      id: resultId('fit_residual', digest({ lane: curve.lane_index, residuals: ruler.residuals }), params.version, parents),
      kind: 'fit_residual',
      status: 'ok',
      input_digest: digest({ lane: curve.lane_index, residuals: ruler.residuals }),
      params_version: params.version,
      parents,
      branch,
      seq: 0,
      value: { lane_index: curve.lane_index, residuals: ruler.residuals, unit: 'px' },
    });
  }

  // --- band MW inference --------------------------------------------------
  for (const curve of curves) {
    if (curve.role === 'ladder') continue;
    const ruler = rulerByLane.get(curve.lane_index);
    const centers = bandsByLane.get(curve.lane_index) ?? [];
    const bandMat = bandMatByLane.get(curve.lane_index);
    if (!ruler || !bandMat) continue;
    const rawYByBandId = new Map(centers.map((c) => [c.band_id, c.y] as const));
    const normalizedCenters = centers.map((c) => ({ ...c, y: normalizeY(c.y) }));
    const groups = groupOverlaps(normalizedCenters, curve.smile_offset_px, params.overlap_min_sep_px);
    for (const group of groups) {
      for (const band of group) {
        if (!spend(1, `mw[${band.band_id}]`)) {
          return { outcome: { kind: 'budget_exhausted', diagnostics }, results, judgements, diagnostics };
        }
        // intensity is sampled in raw image coordinates; geometry uses
        // the orientation-normalized frame
        const intensity = image ? image.intensityAt(band.x, rawYByBandId.get(band.band_id) ?? band.y) : 0;
        const saturated = intensity >= params.saturation_threshold;
        const tailing = (band as BandCenter & { tailing?: boolean }).tailing === true;
        const { estimate, judgements: j } = inferMw({
          band,
          ruler,
          params,
          saturated,
          tailing,
          overlapGroup: group,
        });
        judgements.push(...j);
        const parents = [bandMat.id, ladderMat!.id, lanesMat!.id, imageMat!.id, exposureMat!.id];
        results.push({
          id: resultId('mw_estimate', digest(estimate), params.version, parents),
          kind: 'mw_estimate',
          status: estimate.status,
          input_digest: digest(estimate),
          params_version: params.version,
          parents,
          branch,
          seq: 0,
          value: estimate satisfies MwEstimate,
        });
      }
    }
  }

  // stable ordering: kind, then id — equivalent inputs, identical order
  results.sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
  return { outcome: { kind: 'ok' }, results, judgements, diagnostics };
}

/** Dependency-scoped invalidation: only results whose parent set includes
 *  a changed id are affected; everything else stays valid. */
export function computeInvalidated(results: DerivedResult[], changedIds: ReadonlySet<string>): string[] {
  return results.filter((r) => r.status !== 'superseded' && r.parents.some((p) => changedIds.has(p))).map((r) => r.id);
}
