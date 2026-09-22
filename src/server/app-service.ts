import { readFile } from 'node:fs/promises';
import type {
  AnalysisResult,
  BandCenterMaterial,
  CalibrationParametersV1,
  DecisionRecordedEvent,
  ExportBundle,
  GelEvent,
  InputSummary,
  LadderNominalMaterial,
  LaneBoundaryMaterial,
  Material,
  MaterialRecord,
  ProjectState,
  ScenarioId
} from '../shared/types.ts';
import { FormatCorruptError, IncompleteInputError, ResourceExhaustedError, SemanticImpossibleError } from '../shared/errors.ts';
import { computeAnalysis } from '../domain/calibration.ts';
import { detectAutoFeatures, toAutoMaterials, transformToCorrectedPixels, type DetectionParameters } from '../domain/detection.ts';
import { generateGelPng, IMAGE_HEIGHT, IMAGE_WIDTH, type SyntheticGelSpec } from '../domain/image.ts';
import { parameterHash } from '../domain/parameters.ts';
import { sha256, stableId } from '../domain/identity.ts';
import {
  baselineLadderYs,
  baselineNominalBp,
  baselineSampleBands,
  exposureMaterial,
  imageMaterial,
  manualBandMaterial,
  manualLaneMaterial,
  materialRecord,
  nominalMaterial,
  orientationMaterial,
  PROJECT_ID
} from '../domain/materials.ts';
import { parametersV1, parametersV11 } from '../domain/parameters.ts';
import type { GelStore } from './store.ts';

export interface SeedOptions {
  force?: boolean;
}

interface ScenarioArtifacts {
  scenario: ScenarioId;
  png: Buffer;
  width: number;
  height: number;
  orientationDeg: number;
  materials: Material[];
  parameters: CalibrationParametersV1;
  auto?: ReturnType<typeof detectAutoFeatures>;
}

function fixedTime(seq: number): string {
  return `2026-09-23T00:${String(seq).padStart(2, '0')}:00.000Z`;
}

function detectionParameters(parameters: CalibrationParametersV1): DetectionParameters {
  return {
    minPeakProminence: parameters.minPeakProminence.value,
    saturationThreshold: parameters.saturationThreshold.value,
    minimumSeparation: parameters.minimumSeparation.value,
    overlapSeparation: parameters.overlapSeparation.value,
    maximumExtrapolation: parameters.maximumExtrapolation.value
  };
}

function summary(materials: Material[], imageSha: string): InputSummary {
  const image = materials.find((material): material is Extract<Material, { kind: 'image' }> => material.kind === 'image')!;
  const orientation = materials.find((material): material is Extract<Material, { kind: 'orientation' }> => material.kind === 'orientation')!;
  const exposure = materials.find((material): material is Extract<Material, { kind: 'exposure' }> => material.kind === 'exposure')!;
  const nominal = materials.find((material): material is Extract<Material, { kind: 'ladderNominal' }> => material.kind === 'ladderNominal')!;
  const lane = materials.find((material): material is Extract<Material, { kind: 'laneBoundary' }> => material.kind === 'laneBoundary')!;
  const band = materials.find((material): material is Extract<Material, { kind: 'bandCenter' }> => material.kind === 'bandCenter')!;
  return {
    imageSha256: imageSha,
    orientationDeg: orientation.sourceToDisplayClockwiseDeg.value,
    exposureMs: exposure.exposure.value,
    nominalHash: stableId('nominal', nominal),
    laneHash: stableId('lane', lane),
    bandSourceHash: stableId('bands', band),
    pixelSize: { width: image.width.value, height: image.height.value }
  };
}

function scenarioSpec(scenario: ScenarioId): SyntheticGelSpec {
  if (scenario === 'missingLadderBand') {
    const ys = baselineLadderYs.filter((_, index) => index !== 3);
    return { scenario, ladderYs: ys };
  }
  if (scenario === 'saturation') {
    return {
      scenario,
      sampleBands: {
        'lane-2': [{ y: 132 }, { y: 292 }],
        'lane-3': [{ y: 181, tail: true }],
        'lane-4': [{ y: 237 }],
        'lane-5': [{ y: 315, saturate: true, intensity: 230 }],
        'lane-6': [{ y: 382 }],
        'lane-7': [{ y: 430 }]
      }
    };
  }
  if (scenario === 'localInvalidation') {
    return { scenario, sampleBands: { 'lane-2': [{ y: 132 }], 'lane-7': [{ y: 472 }] } };
  }
  if (scenario === 'rotation') return { scenario, rotateClockwise: 90 };
  if (scenario === 'smile') {
    return {
      scenario,
      laneCurves: { 'lane-3': makeSmileCurve() },
      sampleBands: { 'lane-2': [{ y: 181 }], 'lane-3': [{ y: 181 }], 'lane-4': [{ y: 181 }] }
    };
  }
  return { scenario };
}

function makeSmileCurve() {
  const points: Array<{ x: number; y: number }> = [];
  for (let y = 20; y <= IMAGE_HEIGHT - 20; y += 20) {
    const t = (y - 20) / (IMAGE_HEIGHT - 40);
    points.push({ x: 240 + 18 * Math.sin(Math.PI * t), y });
  }
  return points;
}

function straightSmileLanes(): LaneBoundaryMaterial {
  return {
    ...manualLaneMaterial('baseline'),
    provenance: 'manual-v1'
  };
}

function smileManualBands(): BandCenterMaterial {
  return manualBandMaterial('baseline', {
    sample: [
      { id: 'manual-smile-lane-2', laneId: 'lane-2', y: 181, observedAs: 'point' },
      { id: 'manual-smile-lane-3', laneId: 'lane-3', y: 181, observedAs: 'point' },
      { id: 'manual-smile-lane-4', laneId: 'lane-4', y: 181, observedAs: 'point' }
    ]
  });
}

function saturationManualBands(): BandCenterMaterial {
  return manualBandMaterial('saturation', {
    sample: [
      { id: 'manual-sat-lane-2', laneId: 'lane-2', y: 132, observedAs: 'point' },
      { id: 'manual-sat-lane-3', laneId: 'lane-3', y: 181, observedAs: 'tail' },
      { id: 'manual-sat-lane-5', laneId: 'lane-5', y: 315, observedAs: 'saturated-plateau' }
    ]
  });
}

function overlapManualBands(): BandCenterMaterial {
  return manualBandMaterial('overlap', {
    sample: [
      { id: 'manual-overlap-a', laneId: 'lane-4', y: 230, observedAs: 'overlap' },
      { id: 'manual-overlap-b', laneId: 'lane-4', y: 246, observedAs: 'overlap' },
      { id: 'manual-overlap-lane-6', laneId: 'lane-6', y: 382, observedAs: 'point' }
    ]
  });
}

function localInvalidManualBands(): BandCenterMaterial {
  return manualBandMaterial('localInvalidation', {
    sample: [
      { id: 'manual-local-valid', laneId: 'lane-2', y: 132, observedAs: 'point' },
      { id: 'manual-local-invalid', laneId: 'lane-7', y: 472, observedAs: 'point' }
    ]
  });
}

function nonMonotonicNominal(): LadderNominalMaterial {
  return nominalMaterial([10000, 5000, 3000, 4000, 1500, 1000, 500, 200]);
}

function buildArtifacts(scenario: ScenarioId, parameters: CalibrationParametersV1): ScenarioArtifacts {
  const generated = generateGelPng(scenarioSpec(scenario));
  const orientationDeg = scenario === 'rotation' ? 0 : 0;
  let materials: Material[] = [
    imageMaterial(scenario, generated.sha256, generated.width, generated.height, orientationDeg),
    orientationMaterial(orientationDeg),
    exposureMaterial(),
    nominalMaterial(),
    manualLaneMaterial(scenario),
    manualBandMaterial(scenario)
  ];
  if (scenario === 'smile') materials[4] = straightSmileLanes(), materials[5] = smileManualBands();
  if (scenario === 'saturation') materials[5] = saturationManualBands();
  if (scenario === 'overlap') materials[5] = overlapManualBands();
  if (scenario === 'nonMonotonicRuler') materials[3] = nonMonotonicNominal();
  if (scenario === 'localInvalidation') materials[5] = localInvalidManualBands();
  const auto = detectAutoFeatures(generated.png, orientationDeg, IMAGE_WIDTH, IMAGE_HEIGHT, scenario, detectionParameters(parameters));
  return { scenario, png: generated.png, width: generated.width, height: generated.height, orientationDeg, materials, parameters, auto };
}

class EventWriter {
  private seqByBranch = new Map<string, number>();

  constructor(private readonly store: GelStore) {}

  emit<T extends GelEvent>(branchId: string, parentIds: string[], timestamp: string, actor: GelEvent['actor'], type: T['type'], payload: T['payload']): GelEvent {
    const seq = (this.seqByBranch.get(branchId) ?? 0) + 1;
    this.seqByBranch.set(branchId, seq);
    const event = { id: `${branchId}-e${seq}`, projectId: PROJECT_ID, branchId, seq, parentIds, timestamp, actor, type, payload } as GelEvent;
    this.store.appendEvent(event);
    return event;
  }
}

function recordsFromArtifacts(artifacts: ScenarioArtifacts, createdAt: string, start = 1): MaterialRecord[] {
  return artifacts.materials.map((material, index) => materialRecord(PROJECT_ID, material, createdAt, index + start === start ? undefined : `derived-from-${artifacts.scenario}`));
}

function computeForMaterials(
  eventId: string,
  branchId: string,
  materials: Material[],
  parameters: CalibrationParametersV1,
  imageSha: string,
  createdAt: string
): AnalysisResult {
  const records = materials.map((material, index) => materialRecord(PROJECT_ID, material, createdAt, index === 0 ? undefined : `dep-${index}`));
  return computeAnalysis({
    projectId: PROJECT_ID,
    branchId,
    eventId,
    parameterHash: parameterHash(parameters),
    parameters,
    materials: records,
    inputSummary: summary(materials, imageSha),
    createdAt
  });
}

function addMaterialAndResult(
  writer: EventWriter,
  store: GelStore,
  branchId: string,
  parentId: string,
  seq: number,
  records: MaterialRecord[],
  result: AnalysisResult,
  label: string
): { materialEventIds: string[]; analysisEvent: GelEvent } {
  const materialEventIds: string[] = [];
  let currentParent = parentId;
  records.forEach((record, index) => {
    store.putMaterial(record, branchId);
    const event = writer.emit(
      branchId,
      [currentParent],
      fixedTime(seq + index),
      'importer',
      'material.added',
      { materialId: record.id, changedDirectSourceOnly: label !== 'baseline', changeScope: label }
    );
    materialEventIds.push(event.id);
    currentParent = event.id;
  });
  store.putResult(result);
  const analysisEvent = writer.emit(branchId, [currentParent], fixedTime(seq + records.length), 'domain-engine', 'analysis.recorded', {
    resultId: result.id,
    inputSummary: result.inputSummary,
    parentDependencies: result.parentDependencies,
    parameterVersion: result.parameterVersion,
    status: result.status
  });
  return { materialEventIds, analysisEvent };
}

function decision(
  writer: EventWriter,
  store: GelStore,
  branchId: string,
  parentId: string,
  seq: number,
  targetId: string,
  action: DecisionRecordedEvent['payload']['action'],
  rationale: string,
  basisResultId: string,
  conflictsWith: string[] = []
): GelEvent {
  const id = stableId('decision', [branchId, parentId, targetId, action, rationale]);
  const event = writer.emit(branchId, [parentId], fixedTime(seq), 'reviewer', 'decision.recorded', {
    decisionId: id,
    targetType: 'bandResult',
    targetId,
    action,
    rationale,
    conflictsWith: conflictsWith.length ? conflictsWith : undefined,
    basisResultId
  });
  store.setAdopted(basisResultId, action === 'accepted' || action === 'candidate-selected' || action === 'range-accepted');
  return event;
}

function autoRecords(artifacts: ScenarioArtifacts, createdAt: string): MaterialRecord[] {
  if (!artifacts.auto?.orientationValid) return [];
  const materials = toAutoMaterials(artifacts.auto);
  return [
    materialRecord(PROJECT_ID, materials.lanes, createdAt, 'auto-lane-source'),
    materialRecord(PROJECT_ID, materials.bands, createdAt, 'auto-band-source')
  ];
}

function buildResult(
  branchId: string,
  eventId: string,
  materials: Material[],
  parameters: CalibrationParametersV1,
  imageSha: string,
  createdAt: string
): AnalysisResult {
  return computeForMaterials(eventId, branchId, materials, parameters, imageSha, createdAt);
}

export function seedSampleStore(store: GelStore, options: SeedOptions = {}): void {
  if (store.projectExists(PROJECT_ID)) {
    if (!options.force) return;
    for (const table of ['events', 'materials', 'results', 'blobs', 'import_stages'] as const) store.db.exec(`DELETE FROM ${table}`);
  }
  const writer = new EventWriter(store);
  const baseline = buildArtifacts('baseline', parametersV1());
  const v11 = parametersV11();
  for (const scenario of ['baseline', 'rotation', 'smile', 'missingLadderBand', 'saturation', 'overlap', 'nonMonotonicRuler', 'localInvalidation'] as ScenarioId[]) {
    const artifacts = scenario === 'baseline' ? baseline : buildArtifacts(scenario, parametersV1());
    store.putBlob({ path: `images/${scenario}.png`, mediaType: 'image/png', sha256: artifacts.png === baseline.png ? baselineMaterials(baseline).sha : sha256(artifacts.png), data: artifacts.png }, PROJECT_ID);
  }
  const project = writer.emit('main', [], fixedTime(1), 'importer', 'project.created', {
    name: '胶道标尺：电泳条带、泳道弯曲与分子量校准工作台',
    casePackVersion: '2026-09-23.1'
  });
  const baselineRecords = recordsFromArtifacts(baseline, fixedTime(2));
  let parent = project.id;
  let seq = 2;
  const initialIds: string[] = [];
  baselineRecords.forEach((record) => {
    store.putMaterial(record, 'main');
    const event = writer.emit('main', [parent], fixedTime(seq), 'importer', 'material.added', { materialId: record.id });
    initialIds.push(event.id);
    parent = event.id;
    seq += 1;
  });
  const paramsEvent = writer.emit('main', [parent], fixedTime(seq), 'reviewer', 'parameters.recorded', {
    parameterHash: parameterHash(baseline.parameters),
    parentMaterialIds: baselineRecords.map((record) => record.id),
    parameters: baseline.parameters
  });
  parent = paramsEvent.id;
  seq += 1;

  const autoResult = computeForMaterials('main-auto-analysis', 'main', baseline.materials, baseline.parameters, sha256(baseline.png), fixedTime(seq));
  store.putResult(autoResult);
  const autoEvent = writer.emit('main', [parent], fixedTime(seq), 'domain-engine', 'analysis.recorded', {
    resultId: autoResult.id,
    inputSummary: autoResult.inputSummary,
    parentDependencies: autoResult.parentDependencies,
    parameterVersion: autoResult.parameterVersion,
    status: autoResult.status
  });
  parent = autoEvent.id;
  seq += 1;

  const rejectedTail = decision(writer, store, 'main', parent, seq, autoResult.bands.find((band) => band.laneId === 'lane-3')!.id, 'rejected', '自动候选未区分拖尾，不能作为唯一分子量。', autoResult.id);
  parent = rejectedTail.id;
  seq += 1;

  const manualResult = computeForMaterials('main-manual-analysis', 'main', baseline.materials, baseline.parameters, sha256(baseline.png), fixedTime(seq));
  store.putResult(manualResult);
  const manualEvent = writer.emit('main', [parent], fixedTime(seq), 'domain-engine', 'analysis.recorded', {
    resultId: manualResult.id,
    inputSummary: manualResult.inputSummary,
    parentDependencies: manualResult.parentDependencies,
    parameterVersion: manualResult.parameterVersion,
    status: manualResult.status
  });
  parent = manualEvent.id;
  seq += 1;
  const firstBand = manualResult.bands.find((band) => band.status === 'accepted-unique')!;
  parent = decision(writer, store, 'main', parent, seq, firstBand.id, 'accepted', '人工像素中心与局部 ladder bracket 一致。', manualResult.id).id;
  seq += 1;

  const params11Event = writer.emit('main', [parent], fixedTime(seq), 'reviewer', 'parameters.recorded', {
    parameterHash: parameterHash(v11),
    parentMaterialIds: baselineRecords.map((record) => record.id),
    parameters: v11
  });
  parent = params11Event.id;
  seq += 1;
  const revised = computeForMaterials('main-revised-local', 'main', baseline.materials, v11, sha256(baseline.png), fixedTime(seq));
  store.putResult(revised);
  const revisedEvent = writer.emit('main', [parent], fixedTime(seq), 'domain-engine', 'analysis.recorded', {
    resultId: revised.id,
    inputSummary: revised.inputSummary,
    parentDependencies: revised.parentDependencies,
    parameterVersion: revised.parameterVersion,
    status: revised.status
  });
  parent = revisedEvent.id;
  seq += 1;
  parent = decision(writer, store, 'main', parent, seq, revised.bands.find((band) => band.status === 'locally-invalid')!.id, 'rejected', '修订后不允许外推，超界值保留局部失效原因。', revised.id).id;
  seq += 1;

  createCounterBranches(store, writer, {
    baselineParent: parent,
    baselineRecords,
    baselinePng: baseline.png,
    mainLastSeq: seq
  });
}

function baselineMaterials(artifacts: ScenarioArtifacts): { sha: string } {
  return { sha: sha256(artifacts.png) };
}
