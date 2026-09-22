import type {
  BandMaterial,
  CalibrationParams,
  CalibrationResult,
  Decision,
  DecisionVerdict,
  DomainEvent,
  ImageMaterial,
  LaneMaterial,
  LadderSpec,
  MassResult,
  Project,
  ProjectState
} from './types';
import { PARAMS_BY_VERSION } from './params';
import { detectBands, type DetectionResult } from './detector';
import { buildCalibration, inferMass } from './calibration';
import { cumulativeLength, pointAtLength } from '../shared/geometry';
import { digestOf, stableId } from '../shared/hash';
import { applyEvent, emptyState } from './state';
import { diag } from '../shared/diagnostics';

let counter = 0;
function nowStamp(seed?: number): string {
  counter += 1;
  const t = seed != null ? new Date(Date.UTC(2026, 8, 23, 1, 0, seed)).getTime() : Date.now();
  return new Date(t + counter).toISOString();
}

export function eventId(seq: number, type: string, digestParts: unknown[]): string {
  return stableId('evt', [seq, type, digestParts]);
}

export function laneId(projectId: string, imageId: string, order: number): string {
  return stableId('lane', [projectId, imageId, order]);
}
export function bandId(lane: string, sPx: number, x: number, y: number): string {
  return stableId('band', [lane, Math.round(sPx), Math.round(x), Math.round(y)]);
}
export function ladderSpecId(projectId: string, lane: string): string {
  return stableId('lspec', [projectId, lane]);
}
export function decisionId(bandIdValue: string, at: string): string {
  return stableId('dec', [bandIdValue, at]);
}

export function straightCenterline(image: ImageMaterial, x: number): { x: number; y: number }[] {
  const top = 60;
  const bottom = image.height - 30;
  const pts = [];
  for (let y = top; y <= bottom; y += 10) pts.push({ x, y });
  return pts;
}

export function curvedCenterline(points: { x: number; y: number }[]): { x: number; y: number }[] {
  return points.map((p) => ({ x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10 }));
}

export interface AutoLaneSpec {
  order: number;
  role: 'sample' | 'ladder';
  centerline: { x: number; y: number }[];
  halfWidthPx: number;
}

export interface AutoOutput {
  event: DomainEvent;
  lanes: LaneMaterial[];
  bands: BandMaterial[];
  detections: DetectionResult[];
  sByBand: Map<string, number>;
}

export function runAutoDetection(
  projectId: string,
  branch: string,
  seq: number,
  image: ImageMaterial,
  pixels: Uint8Array,
  laneSpecs: AutoLaneSpec[],
  params: CalibrationParams,
  parents: string[],
  seedStamp?: number,
  invalidated: { bands: string[]; massResults: string[] } = { bands: [], massResults: [] }
): AutoOutput {
  const frame = { width: image.width, height: image.height, pixels, frameId: image.frameId };
  const lanes: LaneMaterial[] = [];
  const bands: BandMaterial[] = [];
  const detections: DetectionResult[] = [];
  const sByBand = new Map<string, number>();

  for (const spec of laneSpecs) {
    const id = laneId(projectId, image.id, spec.order);
    const lane: LaneMaterial = {
      id,
      kind: 'lane',
      imageId: image.id,
      role: spec.role,
      order: spec.order,
      centerline: spec.centerline,
      halfWidthPx: spec.halfWidthPx,
      source: { origin: 'auto', reference: `detector@params-v${params.version}`, capturedAt: nowStamp(seedStamp) }
    };
    lanes.push(lane);
    const det = detectBands(frame, id, spec.centerline, spec.halfWidthPx, params);
    detections.push(det);
    for (const b of det.bands) {
      const idb = bandId(id, b.sPx, b.center.x, b.center.y);
      bands.push({
        id: idb,
        kind: 'band',
        laneId: id,
        imageId: image.id,
        bandKind: 'auto',
        center: { x: Math.round(b.center.x), y: Math.round(b.center.y) },
        flag: b.flag,
        intensity: { value: b.peakIntensity, unit: 'gray8', raw: b.peakIntensity },
        widthPx: Math.round(b.widthHalfMaxPx * 2),
        source: { origin: 'auto', reference: `profile-peak@${Math.round(b.sPx)}px`, capturedAt: nowStamp(seedStamp) }
      });
      sByBand.set(idb, b.sPx);
    }
  }

  const inputDigest = digestOf({ image: image.blobRef, params: params.version, lanes: laneSpecs.map((l) => l.centerline) });
  const at = nowStamp(seedStamp);
  const event: DomainEvent = {
    id: eventId(seq, 'auto-detected', [image.id, params.version, lanes.map((l) => l.id)]),
    seq,
    branch,
    type: 'auto-detected',
    at,
    parents: [...parents, image.id],
    inputDigest,
    payload: {
      lanes,
      bands,
      paramsVersion: params.version,
      invalidatedBandIds: invalidated.bands,
      invalidatedMassResultIds: invalidated.massResults,
      profiles: detections.map((d) => ({ laneId: d.laneId, profile: d.profile }))
    },
    diagnostics: detections.flatMap((d) => d.diagnostics),
    affected: [...invalidated.bands, ...invalidated.massResults]
  };
  return { event, lanes, bands, detections, sByBand };
}

export function computeCalibrationEvent(
  branch: string,
  seq: number,
  image: ImageMaterial,
  spec: LadderSpec,
  ladderBands: BandMaterial[],
  sByBand: Map<string, number>,
  params: CalibrationParams,
  parents: string[],
  seedStamp?: number
): { event: DomainEvent; results: CalibrationResult[]; diagnostics: ReturnType<typeof diag>[] } {
  const built = buildCalibration({ spec, ladderBands, sByBand, params, imageId: image.id });
  const results = built.result ? [built.result] : [];
  const at = nowStamp(seedStamp);
  const event: DomainEvent = {
    id: eventId(seq, 'calibration-computed', [spec.id, params.version, built.chosenMappingId]),
    seq,
    branch,
    type: 'calibration-computed',
    at,
    parents: [...parents, spec.id, ...ladderBands.map((b) => b.id)],
    inputDigest: digestOf({
      spec: spec.id,
      bands: ladderBands.map((b) => [b.id, sByBand.get(b.id)]),
      params: params.version
    }),
    payload: {
      results,
      paramsVersion: params.version,
      chosenMappingId: built.chosenMappingId,
      mappingCandidates: built.mappingCandidates.map((c) => ({ id: c.id, missingOrdinals: c.missingOrdinals, fitScore: c.fitScore }))
    },
    diagnostics: built.diagnostics,
    affected: results.map((r) => r.id)
  };
  return { event, results, diagnostics: built.diagnostics };
}

export function computeMassEvent(
  branch: string,
  seq: number,
  image: ImageMaterial,
  bands: BandMaterial[],
  sByBand: Map<string, number>,
  calibration: CalibrationResult,
  params: CalibrationParams,
  parents: string[],
  clusterResolver: Map<string, { members: BandMaterial[] }>,
  seedStamp?: number
): { event: DomainEvent; results: MassResult[] } {
  const at = nowStamp(seedStamp);
  const results = bands.map((band) => {
    const cluster = clusterResolver.get(band.id);
    const r = inferMass({
      band,
      sPx: sByBand.get(band.id) ?? 0,
      calibration,
      clusterBandIds: cluster?.members.map((m) => m.id) ?? [band.id],
      clusterBands: cluster?.members ?? [band],
      sByBand
    });
    r.computedAt = at;
    r.inputDigest = digestOf({
      calibration: calibration.id,
      band: [band.id, sByBand.get(band.id), band.flag, band.widthPx],
      params: params.version
    });
    return r;
  });
  const event: DomainEvent = {
    id: eventId(seq, 'mass-computed', [calibration.id, results.map((r) => r.id)]),
    seq,
    branch,
    type: 'mass-computed',
    at,
    parents: [...parents, calibration.id, ...bands.map((b) => b.id)],
    inputDigest: digestOf({ calibration: calibration.id, params: params.version }),
    payload: { results, paramsVersion: params.version },
    affected: results.map((r) => r.id)
  };
  return { event, results };
}

export function makeDecisionEvent(
  branch: string,
  seq: number,
  target: MassResult,
  verdict: DecisionVerdict,
  chosenBp: number | null,
  note: string,
  priorConflicts: string[],
  supersedes: string | null,
  seedStamp?: number
): DomainEvent {
  const at = nowStamp(seedStamp);
  const decision: Decision = {
    id: decisionId(target.bandId, at),
    kind: 'decision',
    eventId: '',
    branch,
    targetResultId: target.id,
    bandId: target.bandId,
    verdict,
    chosenBp,
    note,
    supersedesDecisionId: supersedes,
    conflictsWith: priorConflicts,
    at,
    basedOnCalibrationId: target.calibrationId
  };
  const id = eventId(seq, 'decision-made', [decision.id, verdict, chosenBp]);
  decision.eventId = id;
  return {
    id,
    seq,
    branch,
    type: 'decision-made',
    at,
    parents: [target.id, target.calibrationId],
    inputDigest: digestOf({ target: target.id, verdict, chosenBp, note }),
    payload: { decision, conflictsWith: priorConflicts },
    affected: [target.bandId, target.id]
  };
}

export function paramsFor(state: ProjectState, branch: string): CalibrationParams {
  const walk = (name: string): CalibrationParams => state.params[name] ?? (name === 'baseline' ? PARAMS_BY_VERSION[1] : walk('baseline'));
  return walk(branch);
}

export function appendEvent(state: ProjectState, event: DomainEvent): ProjectState {
  return applyEvent(state, event);
}

export function newProject(id: string, name: string, branches: Project['branches'], seedStamp = 0): { project: Project; event: DomainEvent } {
  const project: Project = { id, name, createdAt: nowStamp(seedStamp), branches };
  const seq = 0;
  const event: DomainEvent = {
    id: eventId(seq, 'project-created', [id]),
    seq,
    branch: 'baseline',
    type: 'project-created',
    at: project.createdAt,
    parents: [],
    inputDigest: digestOf({ id, name, branches: Object.keys(branches) }),
    payload: { project, branches }
  };
  return { project, event };
}

export function makeMaterialEvent(branch: string, seq: number, material: unknown, parents: string[], seedStamp?: number): DomainEvent {
  const at = nowStamp(seedStamp);
  return {
    id: eventId(seq, 'material-added', [JSON.stringify(material).length, at]),
    seq,
    branch,
    type: 'material-added',
    at,
    parents,
    inputDigest: digestOf(material),
    payload: { material }
  };
}

export function lanePolylineLength(polyline: { x: number; y: number }[]): number {
  const c = cumulativeLength(polyline);
  return c[c.length - 1];
}

export function arcPoint(polyline: { x: number; y: number }[], s: number) {
  return pointAtLength(polyline, s);
}
