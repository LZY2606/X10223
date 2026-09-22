export type Unit = 'px' | 'bp' | 'ms' | 'degree' | 'count' | 'graylevel-8' | 'sha256-hex';
export type CoordinateFrameId = string;
export type MaterialKind =
  | 'image'
  | 'orientation'
  | 'exposure'
  | 'ladderNominal'
  | 'laneBoundary'
  | 'bandCenter';

export type ScenarioId =
  | 'baseline'
  | 'rotation'
  | 'smile'
  | 'missingLadderBand'
  | 'saturation'
  | 'overlap'
  | 'nonMonotonicRuler'
  | 'localInvalidation';

export interface Quantity<T extends string = string> {
  value: number;
  unit: T;
}

export interface PixelPoint {
  x: Quantity<'px'>;
  y: Quantity<'px'>;
  frame: CoordinateFrameId;
}

export interface PixelPolyline {
  points: Array<{ x: number; y: number }>;
  frame: CoordinateFrameId;
  unit: 'px';
}

export interface ImageMaterial {
  kind: 'image';
  fileName: string;
  mediaType: 'image/png';
  width: Quantity<'px'>;
  height: Quantity<'px'>;
  sha256: Quantity<'sha256-hex'>;
  blobPath: string;
  pixelFrame: CoordinateFrameId;
  scenario: ScenarioId;
  originalRepresentation: {
    colorModel: 'RGBA-grayscale-render';
    bitsPerChannel: 8;
    origin: 'top-left';
  };
}

export interface OrientationMaterial {
  kind: 'orientation';
  upDirection: 'top-is-electrode-negative';
  migrationDirection: 'downward-after-correction';
  sourceToDisplayClockwiseDeg: Quantity<'degree'>;
  sourceFrame: CoordinateFrameId;
  correctedFrame: CoordinateFrameId;
  uncertaintyDeg: Quantity<'degree'>;
  evidence: 'capture-manifest';
}

export interface ExposureMaterial {
  kind: 'exposure';
  exposure: Quantity<'ms'>;
  gain: Quantity<'dimensionless' | 'dB'>;
  gamma: Quantity<'dimensionless'>;
  saturationLevel: Quantity<'graylevel-8'>;
  source: 'capture-manifest';
}

export interface LadderNominalMaterial {
  kind: 'ladderNominal';
  laneId: string;
  order: 'top-to-bottom-in-corrected-frame';
  bands: Array<{
    id: string;
    molecularWeight: Quantity<'bp'>;
    expectedRank: Quantity<'count'>;
    originalToken: string;
  }>;
  unit: 'bp';
}

export interface LaneBoundaryMaterial {
  kind: 'laneBoundary';
  lanes: Array<{
    id: string;
    role: 'ladder' | 'sample';
    left: PixelPolyline;
    center: PixelPolyline;
    right: PixelPolyline;
    sourceFrame: CoordinateFrameId;
    confidence: Quantity<'dimensionless'>;
  }>;
  provenance: 'auto-v1' | 'manual-v1';
}

export interface BandCenterMaterial {
  kind: 'bandCenter';
  bands: Array<{
    id: string;
    laneId: string;
    role: 'ladder' | 'sample';
    nominalBandId?: string;
    center: { x: number; y: number; frame: CoordinateFrameId };
    source: 'auto-v1' | 'manual-v1';
    observedAs: 'point' | 'saturated-plateau' | 'tail' | 'overlap';
    contour?: Array<{ x: number; y: number; intensity: number }>;
  }>;
  provenance: 'auto-v1' | 'manual-v1';
}

export type Material =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderNominalMaterial
  | LaneBoundaryMaterial
  | BandCenterMaterial;

export interface MaterialRecord {
  id: string;
  projectId: string;
  kind: MaterialKind;
  createdAt: string;
  supersedesId?: string;
  scope?: 'global' | { laneId: string; bandId?: string };
  checksum: string;
  material: Material;
}

export interface CalibrationParametersV1 {
  schema: 'gel-calibration-parameters';
  version: '1.0' | '1.1';
  model: 'piecewise-log-linear-migration';
  minPeakProminence: Quantity<'graylevel-8'>;
  saturationThreshold: Quantity<'graylevel-8'>;
  minimumSeparation: Quantity<'px'>;
  overlapSeparation: Quantity<'px'>;
  maximumExtrapolation: Quantity<'px'>;
  bracketPolicy: 'observed-adjacent-anchors-only';
  residualUnit: 'bp-log10';
}

export type EventType =
  | 'project.created'
  | 'material.added'
  | 'parameters.recorded'
  | 'analysis.recorded'
  | 'decision.recorded'
  | 'branch.created'
  | 'counterexample.preserved';

export interface EventBase {
  id: string;
  projectId: string;
  branchId: string;
  seq: number;
  parentIds: string[];
  timestamp: string;
  actor: 'importer' | 'reviewer' | 'domain-engine';
}

export interface ProjectCreatedEvent extends EventBase {
  type: 'project.created';
  payload: { name: string; casePackVersion: string };
}

export interface MaterialAddedEvent extends EventBase {
  type: 'material.added';
  payload: { materialId: string; changedDirectSourceOnly?: boolean; changeScope?: string };
}

export interface ParametersRecordedEvent extends EventBase {
  type: 'parameters.recorded';
  payload: { parameterHash: string; parentMaterialIds: string[]; parameters: CalibrationParametersV1 };
}

export interface AnalysisRecordedEvent extends EventBase {
  type: 'analysis.recorded';
  payload: {
    resultId: string;
    inputSummary: InputSummary;
    parentDependencies: string[];
    parameterVersion: string;
    status: AnalysisStatus;
  };
}

export interface DecisionRecordedEvent extends EventBase {
  type: 'decision.recorded';
  payload: {
    decisionId: string;
    targetType: 'bandResult' | 'calibrationSegment' | 'parameterSet';
    targetId: string;
    action: 'accepted' | 'rejected' | 'candidate-selected' | 'range-accepted' | 'parameter-adjusted';
    rationale: string;
    conflictsWith?: string[];
    basisResultId?: string;
  };
}

export interface BranchCreatedEvent extends EventBase {
  type: 'branch.created';
  payload: { name: string; scenario: ScenarioId; fromEventId: string };
}

export interface CounterexamplePreservedEvent extends EventBase {
  type: 'counterexample.preserved';
  payload: { scenario: ScenarioId; adoptedResultIds: string[]; rejectedResultIds: string[] };
}

export type GelEvent =
  | ProjectCreatedEvent
  | MaterialAddedEvent
  | ParametersRecordedEvent
  | AnalysisRecordedEvent
  | DecisionRecordedEvent
  | BranchCreatedEvent
  | CounterexamplePreservedEvent;

export interface InputSummary {
  imageSha256: string;
  orientationDeg: number;
  exposureMs: number;
  nominalHash: string;
  laneHash: string;
  bandSourceHash: string;
  pixelSize: { width: number; height: number };
}

export type AnalysisStatus = 'complete' | 'diagnostic-only';

export interface Diagnostic {
  code:
    | 'INCOMPLETE_INPUT'
    | 'FORMAT_CORRUPT'
    | 'SEMANTIC_NON_MONOTONIC_RULER'
    | 'SEMANTIC_MISSING_LADDER_BAND'
    | 'SATURATED_BAND_CANDIDATE_ONLY'
    | 'TAIL_CANDIDATE_ONLY'
    | 'OVERLAPPING_BANDS_RANGE_ONLY'
    | 'LOCAL_RULER_INVALID'
    | 'ORIENTATION_AXIS_INVALID'
    | 'RESOURCE_EXHAUSTED'
    | 'CONFLICTING_DECISION';
  severity: 'error' | 'warning' | 'structural';
  message: string;
  position?: { x?: number; y?: number; laneId?: string; bandId?: string; jsonPath?: string };
  unitBasis?: string;
  affectedObjectIds: string[];
}

export interface LadderAnchor {
  id: string;
  nominalBandId: string;
  molecularWeightBp: number;
  migrationPx: number;
  sourceCenterPx: { x: number; y: number; frame: string };
  residualLog10Bp: number;
}

export interface CalibrationSegment {
  id: string;
  fromAnchorId: string;
  toAnchorId: string;
  validMigrationRangePx: { start: number; end: number; unit: 'px' };
  slopeLog10BpPerPx: number;
  interceptLog10Bp: number;
  status: 'valid' | 'invalid-non-monotonic' | 'invalid-missing-anchor';
}

export interface BandInference {
  id: string;
  bandSourceId: string;
  laneId: string;
  centerPx: { x: number; y: number; frame: string };
  migrationPx: number;
  molecularWeight?: { value: number; unit: 'bp'; intervalBp?: [number, number] };
  candidatesBp?: number[];
  status: 'accepted-unique' | 'candidate' | 'interval' | 'locally-invalid' | 'diagnostic-only';
  evidenceSegmentId?: string;
  contour: Array<{ x: number; y: number; intensity: number }>;
  residualLog10Bp?: number;
  diagnostics: Diagnostic[];
}

export interface AnalysisResult {
  id: string;
  eventId: string;
  projectId: string;
  branchId: string;
  status: AnalysisStatus;
  parametersHash: string;
  parameterVersion: string;
  inputSummary: InputSummary;
  parentDependencies: string[];
  createdAt: string;
  anchors: LadderAnchor[];
  segments: CalibrationSegment[];
  bands: BandInference[];
  diagnostics: Diagnostic[];
  adopted: boolean;
}

export interface ProjectState {
  projectId: string;
  name: string;
  branches: BranchState[];
}

export interface BranchState {
  branchId: string;
  name: string;
  scenario: ScenarioId;
  events: GelEvent[];
  materials: MaterialRecord[];
  results: AnalysisResult[];
  decisions: DecisionRecordedEvent[];
  headEventIds: string[];
}

export interface ExportBundle {
  schema: 'gel-ladder-workbench-case-pack';
  schemaVersion: '1.0.0';
  exportedAt: string;
  project: ProjectState;
  blobs: Array<{ path: string; mediaType: string; sha256: string; base64: string }>;
  checksums: { eventsSha256: string; materialsSha256: string };
}
