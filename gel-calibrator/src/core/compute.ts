// Deterministic computation: material set + params => calibrations + inferences.
import {
  BandCenterMaterial, BandInference, CalibrationParams, CalibrationStatus,
  Diagnostic, GelImageMaterial, LadderMaterial, LaneBoundaryMaterial, Material,
  incomplete,
} from './types.js';
import {
  BandInput, buildCalibration, buildLadderPoints, inferBand, makeBudget,
  sortInferences,
} from './calibrate.js';
import { buildLaneGeometry } from './geometry.js';
import { canonicalJSON, sha256Hex } from './ids.js';

export interface ComputeResult {
  calibration: Record<string, CalibrationStatus>;
  inferences: BandInference[];
  diagnostics: Diagnostic[];
  inputDigest: string;
}

export function computeAll(materials: Material[], params: CalibrationParams): ComputeResult {
  const images = materials.filter((m): m is GelImageMaterial => m.kind === 'image');
  const ladders = materials.filter((m): m is LadderMaterial => m.kind === 'ladder');
  const lanes = materials.filter((m): m is LaneBoundaryMaterial => m.kind === 'lane');
  const bands = materials.filter((m): m is BandCenterMaterial => m.kind === 'band');
  const diagnostics: Diagnostic[] = [];
  if (!images.length) throw incomplete('image', 'no original gel image registered');
  if (!ladders.length) throw incomplete('ladder', 'no ladder registered');

  // Build per-lane geometry once. Bands project onto their OWN lane curve:
  // under a "smile" the same raw pixel y can yield different arc-length
  // migrations across lanes, which is exactly why rulers stay lane-local.
  const geomByLane = new Map(lanes.map((lane) => [
    lane.laneId,
    buildLaneGeometry(lane, bands.filter((b) => b.laneId === lane.laneId)),
  ]));

  const calibration: Record<string, CalibrationStatus> = {};
  const allInfs: BandInference[] = [];
  const budget = makeBudget(params);

  // 1) calibrate every ladder lane.
  for (const ladder of ladders) {
    if (!geomByLane.has(ladder.laneId)) {
      throw incomplete(`ladder[${ladder.laneId}].lane`, `lane boundary ${ladder.laneId} missing`);
    }
    const geom = geomByLane.get(ladder.laneId)!;
    const ladderRows = [...geom.bandArc.values()]
      .filter((x) => x.inside && x.band.role === 'ladder')
      .sort((a, b) => a.arc - b.arc).map((x) => x.band);
    const usableCount = ladder.nominals.length - ladder.missingIndexes.length;
    if (ladderRows.length !== usableCount) {
      diagnostics.push({
        code: 'INPUT_INCOMPLETE', location: `ladder[${ladder.laneId}].bands`,
        message: `need ${usableCount} ladder bands (${ladder.missingIndexes.length} declared missing), found ${ladderRows.length}`,
      });
    }
    const ladderInputs: BandInput[] = ladderRows.map((b) => ({
      bandRef: b.id, bandKey: b.bandKey, laneId: b.laneId, centerPx: b.centerPx,
      migrationPx: geom.bandArc.get(b.id)!.arc, ladderIndex: b.ladderIndex,
    }));
    let status: CalibrationStatus;
    try {
      const { points, missing } = buildLadderPoints(ladder, ladderInputs, ladder.missingIndexes);
      status = buildCalibration(ladder.laneId, points, missing, params);
    } catch (e) {
      if (e && typeof e === 'object' && 'diagnostic' in e) {
        status = { state: 'failed', diagnostic: (e as { diagnostic: Diagnostic }).diagnostic };
      } else throw e;
    }
    calibration[ladder.laneId] = status;
    if (status.state === 'degraded') diagnostics.push(...status.diagnostics);
    if (status.state === 'failed') diagnostics.push(status.diagnostic);
  }

  // 2) infer sample bands on EVERY lane; reuse the ruler of that lane's ladder
  //    (the ladder lane) applied to the sample lane's own arc-length migration.
  const ladderByLane = new Map(ladders.map((l) => [l.laneId, l]));
  for (const lane of lanes) {
    const ladder = ladderByLane.get(lane.laneId) ?? ladders[0]!;
    const status = calibration[ladder.laneId]!;
    const geom = geomByLane.get(lane.laneId)!;
    const sampleRows = [...geom.bandArc.values()]
      .filter((x) => x.inside && x.band.role === 'sample')
      .sort((a, b) => a.arc - b.arc).map((x) => x.band);
    for (const b of sampleRows) {
      const input: BandInput = {
        bandRef: b.id, bandKey: b.bandKey, laneId: b.laneId, centerPx: b.centerPx,
        migrationPx: geom.bandArc.get(b.id)!.arc, saturated: b.saturated,
        smeared: b.smeared, overlapGroup: b.overlapGroup,
      };
      if (status.state === 'failed') {
        allInfs.push({
          id: `val_${b.id}_${params.hash ?? 'unversioned'}_failed`,
          bandRef: b.id, bandKey: b.bandKey, laneId: b.laneId,
          verdict: { type: 'invalid', diagnostic: status.diagnostic },
          centerPx: { ...b.centerPx, frame: 'image_raw' },
          migrationPx: { value: input.migrationPx, unit: 'px', frame: 'image_canonical' },
          residuals: [], parents: [b.id], paramsHash: params.hash ?? 'unversioned',
          inputDigest: 'failed-calibration',
        });
      } else {
        allInfs.push(inferBand(input, status, params, budget));
      }
    }
  }

  const inputDigest = sha256Hex(canonicalJSON({
    materials: materials.map((m) => m.id).sort(), params: params.hash,
  }));
  return { calibration, inferences: sortInferences(allInfs), diagnostics, inputDigest };
}
