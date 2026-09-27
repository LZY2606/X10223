export const SCHEMA_VERSION = "gel-evidence/1";
export const PARAMETER_VERSION = "calibration-2026.1";

export type Severity = "error" | "warning" | "info";
export type AppResultKind = "ok" | "incomplete" | "budget" | "corrupt" | "semantic";

export interface UnitValue {
  value: number | null;
  unit: string;
  rawText: string;
  conversionDiagnostic?: Diagnostic;
}

export interface PixelPoint {
  x: number;
  y: number;
  unit: "px";
  frameId: string;
  origin: "top-left";
}

export interface SpatialRegion {
  x: number;
  y: number;
  width: number;
  height: number;
  unit: "px";
  frameId: string;
}

export interface Diagnostic {
  code:
    | "INCOMPLETE_INPUT"
    | "FORMAT_CORRUPT"
    | "RESOURCE_BUDGET_EXHAUSTED"
    | "SEMANTIC_UNRESOLVABLE"
    | "ROTATED_IMAGE"
    | "LANE_NOT_FOUND"
    | "LADDER_BAND_MISSING"
    | "SATURATED_BAND"
    | "TAILED_BAND"
    | "OVERLAPPING_BANDS"
    | "NONMONOTONIC_RULER"
    | "OUT_OF_VALID_REGION"
    | "CONFLICTING_DECISIONS"
    | "UNCONVERTIBLE_VALUE";
  severity: Severity;
  path: string;
  message: string;
  position?: PixelPoint;
  region?: SpatialRegion;
  objectId?: string;
}

export interface RasterImage {
  width: number;
  height: number;
  channels: 1;
  bits: 8;
  pgmBase64: string;
  sha256: string;
}

export interface ImageMaterial {
  kind: "image";
  id: string;
  role: "original-gel" | "rotated-gel" | "smiled-gel" | "missing-ladder-gel" | "saturated-gel" | "overlap-gel";
  filename: string;
  capturedAt: string;
  cameraOrientation: "landscape" | "portrait" | "square";
  orientationSource: string;
  exposure: UnitValue;
  pixelOrigin: "top-left";
  raster: RasterImage;
}

export interface LadderBandNominal {
  id: string;
  rank: number;
  nominal: UnitValue;
}

export interface LadderNominalMaterial {
  kind: "ladder-nominal";
  id: string;
  sourceImageId: string;
  ladderLaneId: string;
  unit: string;
  bands: LadderBandNominal[];
}

export interface CurvePoint {
  id: string;
  at: PixelPoint;
  migration: number;
  migrationUnit: "px";
}

export interface LaneBoundaryMaterial {
  kind: "lane-boundary";
  id: string;
  sourceImageId: string;
  laneId: string;
  label: string;
  origin: "auto-candidate" | "human-revision";
  leftPath: PixelPoint[];
  centerPath: PixelPoint[];
  rightPath: PixelPoint[];
  validFromY: number;
  validToY: number;
}

export interface BandProfileSample {
  y: number;
  x: number;
  intensity: number;
  unit: "px" | "gray8";
}

export interface BandCenterMaterial {
  kind: "band-center";
  id: string;
  sourceImageId: string;
  laneId: string;
  ladderBandId?: string;
  origin: "auto-candidate" | "human-revision";
  center: PixelPoint;
  region: SpatialRegion;
  profile: BandProfileSample[];
  saturated: boolean;
  tailed: boolean;
  overlapGroupId?: string;
}

export type DirectMaterial =
  | ImageMaterial
  | LadderNominalMaterial
  | LaneBoundaryMaterial
  | BandCenterMaterial;

export interface CalibrationParameters {
  version: string;
  interpolation: "piecewise-linear-log10";
  globalFit: "ordinary-least-squares-log10";
  smoothingWindowPx: number;
  allowExtrapolation: false;
  maxLaneSeparationPx: number;
  saturationValue: 255;
  overlapMinPeakCount: 2;
}

export type EventType =
  | "project-created"
  | "direct-material-recorded"
  | "parameter-revised"
  | "decision-recorded"
  | "computation-recorded"
  | "conflict-recorded";

export interface Decision {
  id: string;
  action: "accept" | "reject" | "accept-interval" | "force-invalid";
  targetId: string;
  reason: string;
  mutualExclusionGroup?: string;
}

export interface InputRef {
  materialId: string;
  kind: DirectMaterial["kind"];
  digest: string;
}

export interface ComputationRecord {
  id: string;
  ruleVersion: string;
  inputSummary: string;
  inputs: InputRef[];
  parameterVersion: string;
  parentDependencies: string[];
  outputDigest: string;
  status: AppResultKind;
}

export interface EvidenceEvent {
  id: string;
  projectId: string;
  branchId: string;
  seq: number;
  parentIds: string[];
  type: EventType;
  timestamp: string;
  clockBasis: string;
  payload: Record<string, unknown>;
  inputDigest?: string;
}

export interface Branch {
  id: string;
  projectId: string;
  name: string;
  parentBranchId?: string;
  forkEventId?: string;
  headEventId?: string;
}

export interface Project {
  id: string;
  name: string;
  narrative: string;
  createdAt: string;
  status: "active" | "importing";
  casepackVersion: string;
}

export interface CandidateMolecularWeight {
  id: string;
  bandId: string;
  laneId: string;
  values: UnitValue[];
  valueKind: "point" | "interval" | "candidate-set" | "unresolved";
  status: "candidate" | "interval" | "accepted" | "rejected" | "invalid" | "conflict";
  migration: UnitValue;
  validRegion: { minMigrationPx: number; maxMigrationPx: number; xRadiusPx: number; frameId: string };
  evidenceLadderPointIds: string[];
  interpolationSegment: { fromBandId: string; toBandId: string; formula: string };
  segmentRegion?: SegmentValidRegion;
  diagnostics: Diagnostic[];
  computationId: string;
}

export interface SegmentValidRegion {
  fromBandId: string;
  toBandId: string;
  minMigrationPx: number;
  maxMigrationPx: number;
  xRadiusPx: number;
  frameId: string;
}

export interface CalibrationPoint {
  id: string;
  ladderNominalBandId: string;
  detectedBandId: string;
  point: PixelPoint;
  migrationPx: number;
  nominal: UnitValue;
  fitResidualPx: number;
}

export interface Ruler {
  id: string;
  laneId: string;
  frameId: string;
  unit: string;
  points: CalibrationPoint[];
  validRegion: { minMigrationPx: number; maxMigrationPx: number; xRadiusPx: number; frameId: string };
  segmentRegions: SegmentValidRegion[];
  status: "valid" | "local-only" | "invalid";
  diagnostics: Diagnostic[];
}

export interface ComputationOutput {
  rulers: Ruler[];
  molecularWeights: CandidateMolecularWeight[];
  diagnostics: Diagnostic[];
  status: AppResultKind;
}

export interface CasePackage {
  schema: typeof SCHEMA_VERSION;
  packageVersion: string;
  exportedAt: string;
  clockBasis: string;
  projects: Project[];
  branches: Branch[];
  events: EvidenceEvent[];
  materials: DirectMaterial[];
  computations: RecordedComputation[];
}

export interface RecordedComputation extends ComputationRecord {
  output: ComputationOutput;
}
