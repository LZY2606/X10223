export type Unit = 'px' | 'bp' | 'ms' | 'dB' | 'count' | 'dimensionless';

export interface Quantity {
  value: number;
  unit: Unit;
  originalText?: string;
}

export interface PixelPoint {
  x: number;
  y: number;
  coordinateSystem: 'raw-image';
  unit: 'px';
}

export interface OrientedPoint {
  x: number;
  y: number;
  coordinateSystem: 'oriented-image';
  unit: 'px';
}

export interface SourceRef {
  materialId: string;
  version: string;
  field?: string;
  pixelPoint?: PixelPoint;
}

export interface Provenance {
  origin: 'auto' | 'manual' | 'metadata' | 'derived';
  tool?: string;
  capturedAt: string;
  sources: SourceRef[];
  originalRepresentation?: unknown;
}

export interface ImageMaterial {
  kind: 'image';
  id: string;
  version: string;
  subjectId: string;
  filename: string;
  mediaType: string;
  width: number;
  height: number;
  channels: 1;
  bitsPerSample: 8;
  pixelsBase64: string;
  sha256: string;
  provenance: Provenance;
}

export interface OrientationMaterial {
  kind: 'orientation';
  id: string;
  version: string;
  subjectId: string;
  imageId: string;
  rotationDeg: 0 | 90 | 180 | 270;
  flipHorizontal: boolean;
  flipVertical: boolean;
  direction: 'top-to-bottom-migration';
  provenance: Provenance;
}

export interface ExposureMaterial {
  kind: 'exposure';
  id: string;
  version: string;
  subjectId: string;
  imageId: string;
  exposureTime?: Quantity;
  gain?: Quantity;
  gamma?: Quantity;
  saturationLevel: Quantity;
  provenance: Provenance;
}

export interface NominalBand {
  id: string;
  molecularWeight: Quantity;
  label: string;
  order: number;
  originalText: string;
}

export interface LadderMaterial {
  kind: 'ladder';
  id: string;
  version: string;
  subjectId: string;
  name: string;
  laneSubjectId: string;
  nominalBands: NominalBand[];
  provenance: Provenance;
}

export interface LaneMaterial {
  kind: 'lane';
  id: string;
  version: string;
  subjectId: string;
  imageId: string;
  label: string;
  left: PixelPoint[];
  right: PixelPoint[];
  provenance: Provenance;
}

export interface BandObservation {
  peak: PixelPoint;
  leadingEdgePx: number;
  trailingEdgePx: number;
  radiusPx: number;
  intensity: number;
  saturated: boolean;
}

export interface BandMaterial {
  kind: 'band';
  id: string;
  version: string;
  subjectId: string;
  laneSubjectId: string;
  label: string;
  center: PixelPoint;
  observation: BandObservation;
  provenance: Provenance;
}

export type Material =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderMaterial
  | LaneMaterial
  | BandMaterial;

export type MaterialKind = Material['kind'];

export interface CalibrationParams {
  schema: 'gel-calibration-parameters';
  version: string;
  overlapRadiusFactor: number;
  tailAsymmetryThreshold: number;
  maxLateralResidualPx: number;
  saturationStatus: 'candidate-or-interval';
  missingAnchorPolicy: 'gap-only';
  interpolation: 'linear-log-bp-by-lane-arc-length';
}

export type DecisionStatus =
  | 'accepted'
  | 'rejected'
  | 'adjusted'
  | 'candidate'
  | 'interval'
  | 'conflicted';

export interface EvidenceEvent {
  ruleId:
    | 'smile-local-calibration'
    | 'saturated-candidate-interval'
    | 'tailing-candidate-interval'
    | 'overlap-all-candidates'
    | 'missing-ladder-gap'
    | 'nonmonotonic-ruler-invalid'
    | 'outside-valid-region'
    | 'revision-local-invalidation'
    | 'conflicting-decision-preserved';
  severity: 'info' | 'warning' | 'error';
  message: string;
  affectedObjectIds: string[];
  validRegion?: ArcRegion;
  position?: PixelPoint;
  reasonCode: string;
}

export interface Diagnostic {
  code:
    | 'INCOMPLETE_INPUT'
    | 'FORMAT_CORRUPT'
    | 'SEMANTIC_UNRESOLVABLE'
    | 'RESOURCE_EXHAUSTED'
    | 'OUT_OF_VALID_REGION';
  message: string;
  path: string;
  position?: PixelPoint;
}

export interface ArcRegion {
  laneSubjectId: string;
  sStart: number;
  sEnd: number;
  unit: 'px';
  basis: 'observed-ladder-anchors';
}

export interface CalibrationSegment {
  id: string;
  lowerBandId: string;
  upperBandId: string;
  sStart: number;
  sEnd: number;
  startBp: number;
  endBp: number;
  valid: boolean;
  status: 'direct' | 'missing-anchor-gap' | 'nonmonotonic' | 'outside-range';
  evidence: EvidenceEvent[];
}

export interface MolecularWeightCandidate {
  id: string;
  bandSubjectId: string;
  laneSubjectId: string;
  valueBp?: number;
  intervalBp?: { min: number; max: number };
  status: 'unique' | 'candidate' | 'interval' | 'invalid';
  migrationS: { value: number; unit: 'px'; origin: 'lane-curve-origin' };
  lateralResidual: Quantity;
  segmentId?: string;
  evidence: EvidenceEvent[];
  diagnostics: Diagnostic[];
  alternatives: MolecularWeightCandidate[];
}

export interface ComputationRecord {
  id: string;
  kind: 'molecular-weight-inference';
  ruleVersion: string;
  parameterVersion: string;
  inputSummary: Record<string, string>;
  parentDependencyIds: string[];
  candidates: MolecularWeightCandidate[];
  segments: CalibrationSegment[];
  laneCurves: LaneCurve[];
  createdAt: string;
}

export interface LaneCurve {
  laneSubjectId: string;
  points: OrientedPoint[];
  arcLength: Quantity;
}

export interface DecisionEventPayload {
  subjectId: string;
  status: DecisionStatus;
  rationale: string;
  candidateId?: string;
  adjustedValueBp?: number;
  conflictsWithEventId?: string;
}

export type WorkflowEventPayload =
  | { type: 'ProjectCreated'; name: string; casePackVersion: string }
  | { type: 'MaterialCommitted'; material: Material }
  | { type: 'ParameterActivated'; params: CalibrationParams; supersedes?: string }
  | { type: 'ComputationRecorded'; record: ComputationRecord }
  | ({ type: 'DecisionMade' } & DecisionEventPayload)
  | { type: 'BranchCreated'; branchId: string; name: string; parentBranchId: string; parentEventId: string; reason: string };

export interface WorkflowEvent {
  id: string;
  projectId: string;
  ordinal: number;
  branchId: string;
  parentEventIds: string[];
  timestamp: string;
  payload: WorkflowEventPayload;
}

export interface Branch {
  id: string;
  name: string;
  parentBranchId?: string;
  parentEventId?: string;
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  casePackVersion: string;
  createdAt: string;
}

export interface CaseScenario {
  id: string;
  title: string;
  changedSource: string;
  baselineMaterialIds: string[];
  patchMaterial: Material;
  expectedRuleIds: EvidenceEvent['ruleId'][];
  expectedAffectedSubjects: string[];
  adoptedEventId?: string;
  unadoptedEventId?: string;
}

export interface CasePack {
  schema: 'gel-calibration-offline-case-pack';
  version: string;
  generatedAt: string;
  projectName: string;
  materials: Material[];
  initialParams: CalibrationParams;
  scenarios: CaseScenario[];
  narrative: string[];
}
