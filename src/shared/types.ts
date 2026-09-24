export type UnitSystem = "bp" | "kDa" | "nt" | "px" | "mm" | "count" | "ratio";

export interface QtyInput {
  value: string;
  unit: string;
}

export interface Qty extends QtyInput {
  valueCanonical?: number;
  canonicalUnit?: UnitSystem;
  convertDiagnostic?: string;
}

export type SourceKind =
  | "image"
  | "orientation"
  | "exposure"
  | "ladder-nominal"
  | "lane-boundary"
  | "band-center";

export type CoordinateFrame =
  | "raw-image-px"
  | "oriented-image-px"
  | "lane-s"
  | "ladder-migration";

export interface Point {
  x: number;
  y: number;
}

export interface PixelPoint extends Point {
  frame: CoordinateFrame;
  imageId?: string;
  uncertaintyPx?: number;
}

export interface OriginTrace {
  kind: SourceKind;
  materialId: string;
  materialVersion: string;
  at?: PixelPoint;
  bbox?: { x0: number; y0: number; x1: number; y1: number; frame: CoordinateFrame };
  note?: string;
}

export interface ImageMaterial {
  kind: "image";
  id: string;
  version: string;
  pngSha256: string;
  width: number;
  height: number;
  createdAt: string;
  origin: string;
  pixelFormat: string;
  derivedFrom?: { imageId: string; transform: string; rotationDeg?: number };
  originTraces: OriginTrace[];
}

export interface OrientationMaterial {
  kind: "orientation";
  id: string;
  version: string;
  imageId: string;
  rotationDeg: number;
  flipH: boolean;
  flipV: boolean;
  migrationDirection: "down" | "up" | "left" | "right";
  decidedBy: string;
  originTraces: OriginTrace[];
}

export interface ExposureMaterial {
  kind: "exposure";
  id: string;
  version: string;
  imageId: string;
  exposureTime: QtyInput;
  gain?: string;
  bitDepth: number;
  saturationLevel: number;
  measured: { maxIntensity: number; saturatedPixelCount: number };
  originTraces: OriginTrace[];
}

export interface LadderBandNominal {
  label: string;
  molecularWeight: QtyInput;
  expectedMigrationHintPx?: number;
  present: boolean;
}

export interface LadderNominalMaterial {
  kind: "ladder-nominal";
  id: string;
  version: string;
  laneId: string;
  name: string;
  manufacturerNote?: string;
  bands: LadderBandNominal[];
  unit: string;
  originTraces: OriginTrace[];
}

export interface Polyline {
  points: PixelPoint[];
}

export interface LaneMaterial {
  kind: "lane";
  id: string;
  version: string;
  imageId: string;
  name: string;
  leftBoundary: Polyline;
  rightBoundary: Polyline;
  centerline: Polyline;
  originTraces: OriginTrace[];
}

export type BandShape = "sharp" | "tailed" | "saturated" | "overlapped";

export interface BandMaterial {
  kind: "band";
  id: string;
  version: string;
  laneId: string;
  imageId: string;
  center: PixelPoint;
  profilePeak: QtyInput;
  fwhmPx?: number;
  shape: BandShape;
  saturated: boolean;
  tailing?: QtyInput;
  overlapGroupId?: string;
  ladderLabel?: string;
  peakWidthPx?: number;
  originTraces: OriginTrace[];
}

export interface AlignmentAnchor {
  ladderArcFraction: number;
  laneArcFraction: number;
  contourPoint?: PixelPoint;
}

export interface LaneAlignmentMaterial {
  kind: "lane-alignment";
  id: string;
  version: string;
  imageId: string;
  ladderLaneId: string;
  perLane: { laneId: string; anchors: AlignmentAnchor[]; originTraces: OriginTrace[] }[];
  originTraces: OriginTrace[];
}

export type Material =
  | LaneAlignmentMaterial
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderNominalMaterial
  | LaneMaterial
  | BandMaterial;

export interface CalibrationParams {
  kind: "calibration-params";
  id: string;
  version: string;
  interpolation: "piecewise-linear" | "semilog-linear";
  useSmileAlignment: boolean;
  saturationRatioThreshold: number;
  overlapFwhmRatio: number;
  extrapolationTolerancePx: number;
  paramSetVersion: string;
  parentParamsId?: string;
}

export type Severity = "error" | "warning" | "info";

export type DiagnosticCode =
  | "INCOMPLETE_INPUT"
  | "SEMANTIC_NONMONOTONIC_RULER"
  | "SEMANTIC_NO_RULER"
  | "SEMANTIC_LADDER_BAND_MISSING"
  | "FORMAT_CORRUPT"
  | "RESOURCE_BUDGET"
  | "SATURATED_REGION"
  | "TAILING_PRESENT"
  | "OVERLAPPING_BANDS"
  | "OUTSIDE_VALID_REGION"
  | "UNCONVERTIBLE_UNIT"
  | "CONFLICTING_DECISION"
  | "REVISION_LOCAL_INVALIDATION"
  | "SEMANTIC_PROJECT_INCONSISTENT";

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  path: string;
  objectIds?: string[];
}

export type BandInferenceStatus = "unique" | "interval" | "candidate" | "invalid";

export interface RulerPoint {
  bandId?: string;
  label: string;
  migration: number;
  molecularWeight: Qty;
  residual: Qty;
  withinValidRegion: boolean;
}

export interface RulerSegment {
  id: string;
  labelA: string;
  labelB: string;
  migrationA: number;
  migrationB: number;
  mwA: number;
  mwB: number;
  valid: boolean;
}

export interface Ruler {
  laneId: string;
  frame: CoordinateFrame;
  validRegion: { migrationMin: number; migrationMax: number } | null;
  points: RulerPoint[];
  segments: RulerSegment[];
  diagnostics: Diagnostic[];
}

export interface BandResult {
  id: string;
  bandId: string;
  laneId: string;
  migration: number;
  status: BandInferenceStatus;
  candidates: Qty[];
  range?: { low: Qty; high: Qty };
  point?: Qty;
  segmentId?: string;
  rulerPointLabels?: string[];
  diagnostics: Diagnostic[];
  valueIds: string[];
}

export interface ComputeRun {
  id: string;
  branch: string;
  inputSummary: Record<string, string>;
  paramSetVersion: string;
  paramsId: string;
  parentRunId?: string;
  parents: string[];
  status: "ok" | "incomplete" | "semantic-error" | "format-error" | "budget";
  rulers: Ruler[];
  bands: BandResult[];
  diagnostics: Diagnostic[];
  createdAt: string;
}

export type EventType =
  | "project-created"
  | "material-recorded"
  | "material-revised"
  | "params-revised"
  | "computed"
  | "decision-made"
  | "branch-created"
  | "scenario-applied";

export type DecisionValue = "accept" | "reject" | "adjust";

export interface ProjectCreatedPayload {
  project: ProjectMeta;
}

export interface MaterialPayload {
  material: Material;
  supersedesId?: string;
  scenarioRef?: string;
}

export interface ParamsPayload {
  params: CalibrationParams;
}

export interface ComputedPayload {
  run: ComputeRun;
}

export interface DecisionPayload {
  targetType: "band" | "ruler-point" | "value" | "params";
  targetId: string;
  decision: DecisionValue;
  rationale: string;
  adjustedValue?: QtyInput;
  affectedRunId: string;
  conflictWith?: string[];
}

export interface BranchCreatedPayload {
  newBranch: string;
  fromBranch: string;
  fromEventId: string;
  reason: string;
}

export interface ScenarioAppliedPayload {
  scenarioId: string;
  title: string;
  changedSource: SourceKind;
  affectedObjectIds: string[];
  recordedMaterials: string[];
  note: string;
}

export interface EventEnvelope {
  id: string;
  seq: number;
  projectId: string;
  branch: string;
  type: EventType;
  payload: unknown;
  parents: string[];
  branchParent?: { branch: string; atEventId: string };
  createdAt: string;
  author: string;
  scenarioRef?: string;
}

export interface ProjectMeta {
  id: string;
  name: string;
  description: string;
  createdAt: string;
  schemaVersion: number;
}

export interface BundleManifest {
  kind: "gel-ruler-bundle";
  bundleVersion: 1;
  schemaVersion: number;
  project: ProjectMeta;
  exportedAt: string;
  eventCount: number;
  pngCount: number;
  budget: ResourceBudget;
  creator: string;
}

export interface ResourceBudget {
  maxEvents: number;
  maxPngBytes: number;
  maxImageDimension: number;
}

export const DEFAULT_BUDGET: ResourceBudget = {
  maxEvents: 20000,
  maxPngBytes: 32 * 1024 * 1024,
  maxImageDimension: 8192
};
