import type {
  BandObservation,
  BranchView,
  CalibrationSegment,
  CaptureOrientation,
  DecisionTarget,
  DerivationRecord,
  Diagnostic,
  Event,
  ExposureSetting,
  ImageMaterial,
  LadderRung,
  LaneGeometry,
  LocalRuler,
  MolecularWeightResult,
  ParameterName,
  ParameterRevision,
} from '../shared/model.js';
import { digestOf } from '../shared/ids.js';
import { defaultParameters, parameterVersionId } from './parameters.js';
import {
  DEFAULT_CALIBRATION_PARAMETERS,
  buildLocalRuler,
  inferMolecularWeight,
} from './calibration.js';
import type { DetectedBand } from './detection.js';
import { detectBandsAlongLane } from './detection.js';
import type { GrayRaster } from './image.js';

export interface RasterResolver {
  (blobId: string): GrayRaster | undefined;
}

export interface ReplayOptions {
  raster?: GrayRaster;
  untilEventId?: string;
}

export interface ReplayState {
  view: BranchView;
  proposals: {
    lanes?: { lanes: LaneGeometry[]; derivationId: string };
    bands?: { bands: DetectedBand[]; derivationId: string };
  };
  diagnostics: Diagnostic[];
  pendingProposals: Event[];
  pendingKinds?: DerivationRecord['kind'][];
  ladderLaneId: string | null;
}

export interface ReplayResult extends ReplayState {
  eventsApplied: number;
  reached: boolean;
}

const PX_PER_MM = 10;

function emptyView(branchId: string): BranchView {
  const parameters = defaultParameters();
  return {
    branchId,
    atEventId: '',
    ladderRungs: [],
    ladderLaneId: null,
    lanes: [],
    bands: [],
    rulers: [],
    molecularWeights: [],
    parameters,
    paramVersionId: parameterVersionId(parameters),
    decisions: [],
    diagnostics: [],
    derivations: [],
    acceptedBandIds: [],
    rejectedBandIds: [],
  };
}

export function replay(
  branchId: string,
  events: Event[],
  options: ReplayOptions = {},
): ReplayResult {
  const view = emptyView(branchId);
  const state: ReplayState = { view, proposals: {}, diagnostics: [], pendingProposals: [], ladderLaneId: null };
  let reached = options.untilEventId === undefined;
  let applied = 0;

  for (const event of events) {
    applyEvent(state, event, options);
    applied++;
    if (options.untilEventId && event.id === options.untilEventId) {
      reached = true;
      break;
    }
  }

  view.acceptedBandIds = view.bands
    .filter((b) => !view.decisions.some((d) => d.target.type === 'bandDetection' && d.target.bandId === b.bandId && d.kind === 'reject'))
    .map((b) => b.bandId);
  view.rejectedBandIds = view.decisions
    .filter((d) => d.target.type === 'bandDetection' && d.kind === 'reject')
    .map((d) => (d.target as { bandId: string }).bandId);

  return { ...state, eventsApplied: applied, reached };
}

function applyEvent(state: ReplayState, event: Event, options: ReplayOptions): void {
  const view = state.view;
  view.atEventId = event.id;
  switch (event.kind) {
    case 'image-imported': {
      view.image = event.payload.image as ImageMaterial;
      state.diagnostics = [];
      state.proposals = {};
      state.pendingProposals = [];
      state.pendingKinds = [];
      view.lanes = [];
      view.bands = [];
      view.rulers = [];
      view.molecularWeights = [];
      view.derivations = [];
      break;
    }
    case 'capture-orientation-recorded':
      view.orientation = event.payload.orientation as CaptureOrientation;
      break;
    case 'exposure-recorded':
      view.exposure = event.payload.exposure as ExposureSetting;
      break;
    case 'ladder-spec-recorded': {
      view.ladderRungs = event.payload.rungs as LadderRung[];
      state.ladderLaneId = (event.payload.ladderLaneId as string) ?? state.ladderLaneId;
      view.ladderLaneId = state.ladderLaneId;
      validateUnits(view);
      scheduleDerivations(state, event, ['calibration', 'molecular-weight']);
      break;
    }
    case 'lane-geometry-recorded':
      view.lanes = event.payload.lanes as LaneGeometry[];
      scheduleDerivations(state, event, ['band-detection', 'calibration', 'molecular-weight']);
      break;
    case 'bands-recorded':
      view.bands = event.payload.bands as BandObservation[];
      scheduleDerivations(state, event, ['calibration', 'molecular-weight']);
      break;
    case 'rung-assigned': {
      const rungId = event.payload.rungId as string;
      const bandId = event.payload.bandId as string | null;
      const rung = view.ladderRungs.find((r) => r.rungId === rungId);
      if (rung) {
        rung.bandId = bandId;
        rung.observed = bandId !== null;
        scheduleDerivations(state, event, ['calibration', 'molecular-weight']);
      }
      break;
    }
    case 'rung-withheld': {
      const rungId = event.payload.rungId as string;
      const rung = view.ladderRungs.find((r) => r.rungId === rungId);
      if (rung) {
        rung.observed = false;
        rung.bandId = null;
        scheduleDerivations(state, event, ['calibration', 'molecular-weight']);
      }
      break;
    }
    case 'parameter-revised': {
      const revision = event.payload.revision as ParameterRevision;
      view.parameters[revision.name] = revision.newValue as never;
      view.paramVersionId = parameterVersionId(view.parameters);
      scheduleDerivations(state, event, ['band-detection', 'calibration', 'molecular-weight']);
      break;
    }
    case 'decision-recorded': {
      const target = event.payload.target as DecisionTarget;
      const kind = event.payload.kind as BranchView['decisions'][number]['kind'];
      const note = event.payload.note as string | undefined;
      const idx = view.decisions.findIndex((d) => JSON.stringify(d.target) === JSON.stringify(target));
      const entry = { target, kind, note, atEventId: event.id };
      if (idx >= 0) view.decisions[idx] = entry;
      else view.decisions.push(entry);
      if (target.type === 'molecularWeight' || target.type === 'calibration') {
        scheduleDerivations(state, event, ['molecular-weight']);
      }
      break;
    }
    case 'derivation-recorded':
      absorbDerivation(state, event);
      break;
    case 'branch-created':
    case 'project-created':
      break;
  }

  flushDerivations(state, event, options);
}

function scheduleDerivations(state: ReplayState, event: Event, kinds: DerivationRecord['kind'][]): void {
  state.pendingProposals.push(event);
  state.pendingKinds = kinds;
}

function flushDerivations(state: ReplayState, event: Event, options: ReplayOptions): void {
  if (!state.pendingKinds || !state.pendingKinds.length) return;
  const kinds = state.pendingKinds;
  state.pendingKinds = [];
  state.pendingProposals = [];
  runDerivations(state, kinds, event, options);
}

function validateUnits(view: BranchView): void {
  for (const rung of view.ladderRungs) {
    if (rung.nominalBp.value === null && !rung.nominalBp.diagnostic) {
      rung.nominalBp.diagnostic = 'LADDER-NOMINAL-UNPARSEABLE';
    }
  }
}

function absorbDerivation(state: ReplayState, event: Event): void {
  const record = event.payload.record as DerivationRecord;
  const view = state.view;
  view.derivations = view.derivations.filter((d) => d.derivationId !== record.derivationId);
  view.derivations.push(record);
  const output = event.payload.output as Record<string, unknown>;
  switch (record.kind) {
    case 'calibration':
      view.rulers = output.rulers as LocalRuler[];
      break;
    case 'molecular-weight':
      view.molecularWeights = output.results as MolecularWeightResult[];
      break;
    case 'local-invalidation':
      view.diagnostics = [...view.diagnostics, ...(output.diagnostics as Diagnostic[])];
      break;
    default:
      break;
  }
}

function runDerivations(
  state: ReplayState,
  kinds: DerivationRecord['kind'][],
  cause: Event,
  options: ReplayOptions,
): void {
  const view = state.view;
  view.diagnostics = view.diagnostics.filter((d) => !d.code?.startsWith('DERIVED-'));
  const parents = [cause.id];
  const inputSummary = {
    imageBlobId: view.image?.blobId ?? null,
    laneCount: view.lanes.length,
    bandCount: view.bands.length,
    rungCount: view.ladderRungs.length,
  };

  if (kinds.includes('band-detection') && options.raster && view.lanes.length) {
    const params = detectionParams(view.parameters);
    const detected = view.lanes.flatMap((lane) =>
      detectBandsAlongLane(options.raster!, lane, params, view.image!.blobId),
    );
    state.proposals.bands = {
      bands: detected,
      derivationId: derivationId('band-detection', parents, view.paramVersionId, inputSummary),
    };
  }

  if (kinds.includes('calibration') && view.lanes.length && view.ladderLaneId) {
    const ladderLane = view.lanes.find((lane) => lane.laneId === view.ladderLaneId);
    if (ladderLane) {
      const params = calibrationParams(view.parameters);
      const invalidations = localInvalidations(view, cause);
      view.diagnostics.push(...invalidations);
      const ruler = buildLocalRuler(ladderLane, view.ladderRungs, view.bands, params);
      view.rulers = [ruler];
      const record: DerivationRecord = {
        derivationId: derivationId('calibration', parents, view.paramVersionId, {
          ...inputSummary,
          ladderLaneId: ladderLane.laneId,
          segmentCount: ruler.segments.length,
        }),
        kind: 'calibration',
        inputSummary: { ...inputSummary, ladderLaneId: ladderLane.laneId },
        paramVersionId: view.paramVersionId,
        parents,
        outputDigest: digestOf(ruler),
        status: ruler.diagnostics.some((d) => d.severity === 'error') ? 'impossible' : ruler.diagnostics.length ? 'diagnostics' : 'ok',
        affectedObjects: [ladderLane.laneId, ...ruler.segments.map((s) => `${s.rungA}-${s.rungB}`)],
      };
      view.derivations = view.derivations.filter((d) => d.kind !== 'calibration');
      view.derivations.push(record);
    }
  }

  if (kinds.includes('molecular-weight') && view.rulers.length && view.bands.length) {
    const params = calibrationParams(view.parameters);
    const results: MolecularWeightResult[] = [];
    for (const band of view.bands) {
      const lane = view.lanes.find((l) => l.laneId === band.laneId);
      const ruler = view.rulers[0];
      if (!lane || !ruler) continue;
      const derivationIdValue = derivationId('molecular-weight', [...parents, band.bandId], view.paramVersionId, {
        sHint: band.center,
      });
      const result = inferMolecularWeight(band, lane, ruler, params, view.bands, derivationIdValue);
      const overridden = view.decisions.find(
        (d) => d.target.type === 'molecularWeight' && d.target.bandId === band.bandId,
      );
      if (overridden?.kind === 'reject') {
        result.diagnostics.push({ code: 'MW-REJECTED', severity: 'info', message: '人工否定：该结果未采纳但保留', bandId: band.bandId, laneId: band.laneId });
      }
      results.push(result);
    }
    view.molecularWeights = results;
    const record: DerivationRecord = {
      derivationId: derivationId('molecular-weight', parents, view.paramVersionId, inputSummary),
      kind: 'molecular-weight',
      inputSummary,
      paramVersionId: view.paramVersionId,
      parents,
      outputDigest: digestOf(results),
      status: results.some((r) => r.status === 'impossible') ? 'impossible' : results.some((r) => r.diagnostics.length) ? 'diagnostics' : 'ok',
      affectedObjects: results.map((r) => r.bandId),
    };
    view.derivations = view.derivations.filter((d) => d.kind !== 'molecular-weight');
    view.derivations.push(record);
  }
}

function localInvalidations(view: BranchView, cause: Event): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  if (cause.kind === 'rung-withheld' || cause.kind === 'rung-assigned') {
    diagnostics.push({
      code: 'DERIVED-LOCAL-INVALIDATION',
      severity: 'info',
      message: `源数据改动 ${cause.payload.rungId as string}：仅使包含该 ladder 点的插值段及落在其中的分子量失效，其余区间仍沿用旧版`,
      rungId: cause.payload.rungId as string,
    });
  }
  if (cause.kind === 'parameter-revised') {
    diagnostics.push({
      code: 'DERIVED-LOCAL-INVALIDATION',
      severity: 'info',
      message: `参数修订 ${(cause.payload.revision as ParameterRevision).name}：按依赖范围重算，旧事件视图保留旧参数版本`,
    });
  }
  return diagnostics;
}

function derivationId(kind: string, parents: string[], paramVersion: string, summary: Record<string, unknown>): string {
  return `der_${digestOf([kind, parents, paramVersion, summary]).slice(0, 16)}`;
}

function detectionParams(values: Record<ParameterName, number | string | boolean>) {
  return {
    saturationThreshold: Number(values.saturationThreshold),
    tailingAsymmetry: Number(values.tailingAsymmetry),
    overlapSeparationPx: Number(values.overlapSeparationPx),
    bandSnapping: Boolean(values.bandSnapping),
  };
}

function calibrationParams(values: Record<ParameterName, number | string | boolean>) {
  return {
    ...DEFAULT_CALIBRATION_PARAMETERS,
    saturationThreshold: Number(values.saturationThreshold),
    tailingAsymmetry: Number(values.tailingAsymmetry),
    overlapSeparationPx: Number(values.overlapSeparationPx),
    extrapolationBudgetMm: Number(values.extrapolationBudgetMm),
    pxPerMm: PX_PER_MM,
  };
}
