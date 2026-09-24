/**
 * Domain model for the gel-lane ruler workbench.
 *
 * Layering:
 *  - Materials are immutable facts imported or declared once (image, capture
 *    orientation, exposure, ladder nominals, lane boundaries, band centres).
 *    Revisions append a new material with a supersedes pointer; history stays.
 *  - Derived results are immutable analysis outputs. They record an input
 *    digest, parameter version and parent dependencies; they never overwrite.
 *  - Decisions are reviewer accept/reject/adjust actions attached to a derived
 *    result at a fixed event position.
 */
import type { PixelPoint, Quantity } from './units.js';

export type RuleVersion = 'rules-2026.09.1';
export const RULE_VERSION: RuleVersion = 'rules-2026.09.1';

// ---------------------------------------------------------------------------
// Diagnostics: three deliberately distinct failure outcomes.
// ---------------------------------------------------------------------------

export type DiagnosticSeverity = 'error' | 'warning';

export type DiagnosticCode =
  | 'INCOMPLETE_INPUT'
  | 'SEMANTIC_NO_SOLUTION'
  | 'FORMAT_CORRUPT'
  | 'BUDGET_EXHAUSTED'
  | 'NON_MONOTONIC_RULER'
  | 'MISSING_LADDER_BAND'
  | 'SATURATED_BAND'
  | 'OVERLAPPING_BANDS'
  | 'SMEAR_TAIL'
  | 'OUTSIDE_VALID_REGION'
  | 'CONFLICTING_DECISION'
  | 'PROVENANCE_MISMATCH'
  | 'UNPARSEABLE_QUANTITY';

export interface Diagnostic {
  code: DiagnosticCode;
  message: string;
  severity: DiagnosticSeverity;
  /** Stable object identity the diagnostic is attached to, plus a path. */
  subject?: { kind: string; id: string };
  /** JSON-pointer-ish location inside the offending payload. */
  path?: string;
  /** Position in pixel space, when the problem is geometric. */
  at?: { x: number; y: number; frame: string };
}

export type OutcomeKind = 'ok' | 'semantic_no_solution' | 'format_corrupt' | 'budget_exhausted';

// ---------------------------------------------------------------------------
// Materials (immutable layer).
// ---------------------------------------------------------------------------

export type MaterialKind =
  | 'image'
  | 'captureOrientation'
  | 'exposure'
  | 'ladderNominal'
  | 'laneBoundary'
  | 'bandCenter';

export interface ImageMaterial {
  kind: 'image';
  id: string;
  seq: number;
  label: string;
  widthPx: number;
  heightPx: number;
  /** Grayscale 0..255 row-major, length width*height. */
  pixels: Uint8Array;
  pngBase64: string;
  pixelSha256: string;
  byteLength: number;
}

export interface CaptureOrientationMaterial {
  kind: 'captureOrientation';
  id: string;
  seq: number;
  imageSeq: number;
  /** Clockwise rotation needed to display/analyse the gel upright (deg). */
  rotationDeg: 0 | 90 | 180 | 270;
  source: string;
}

export interface ExposureMaterial {
  kind: 'exposure';
  id: string;
  seq: number;
  imageSeq: number;
  /** Exposure time with unit kept explicit. */
  duration: Quantity;
  /** Detector saturation ceiling in 8-bit counts for this capture. */
  saturationCeiling: number;
  saturatedPixelFraction: Quantity; // fraction, unit 'dimensionless'
  source: string;
}

export interface RawNominalEntry {
  index: number;
  /** Verbatim token, e.g. "1,500 bp" or "??". */
  raw: string;
  parsed: Quantity | null;
  parseError?: string;
}

export interface LadderNominalMaterial {
  kind: 'ladderNominal';
  id: string;
  seq: number;
  ladderLaneId: string;
  entries: RawNominalEntry[];
  source: string;
}

/** A polyline in upright pixel coordinates; left/right bound per lane. */
export interface LaneBoundaryMaterial {
  kind: 'laneBoundary';
  id: string;
  seq: number;
  imageSeq: number;
  laneId: string;
  side: 'left' | 'right';
  points: PixelPoint[];
  origin: 'auto' | 'manual';
  source: string;
}

export interface BandCenterMaterial {
  kind: 'bandCenter';
  id: string;
  seq: number;
  imageSeq: number;
  laneId: string;
  center: PixelPoint;
  /** True when this is an automatic candidate rather than a reviewed point. */
  candidate: boolean;
  origin: 'auto' | 'manual';
  source: string;
}

export type Material =
  | ImageMaterial
  | CaptureOrientationMaterial
  | ExposureMaterial
  | LadderNominalMaterial
  | LaneBoundaryMaterial
  | BandCenterMaterial;

// ---------------------------------------------------------------------------
// Derived layer.
// ---------------------------------------------------------------------------

export interface ParamSet {
  version: RuleVersion;
  /** Smoothing window for lane intensity profile (pixels). */
  profileSmoothPx: number;
  /** Minimum peak prominence as a fraction of profile range. */
  minProminenceFraction: number;
  /** Fraction of saturated pixels in a footprint that flags saturation. */
  saturationFractionThreshold: number;
  /** Overlap threshold on shared-peak footprint (fraction). */
  overlapFractionThreshold: number;
  /** Allowed extrapolation beyond ladder range (migration px). */
  extrapolationMarginPx: number;
}

export const DEFAULT_PARAMS: ParamSet = {
  version: RULE_VERSION,
  profileSmoothPx: 3,
  minProminenceFraction: 0.08,
  saturationFractionThreshold: 0.05,
  overlapFractionThreshold: 0.35,
  extrapolationMarginPx: 8,
};

export type LaneGeometryId = string;
export type ProfileId = string;
export type CalibrationId = string;
export type InferenceId = string;

export interface LaneGeometryResult {
  id: LaneGeometryId;
  laneId: string;
  imageSeq: number;
  /** Arc-length-parameterised polyline (t in [0,1]) in upright pixels. */
  centerline: PixelPoint[];
  left: PixelPoint[];
  right: PixelPoint[];
  /** Arc length per t step in pixels. */
  arcLengthsPx: number[];
  totalArcLengthPx: number;
  /** True when the centreline bends enough that same-y != same migration. */
  smileDetected: boolean;
  smileAmplitudePx: number;
  inputDigest: string;
  paramsVersion: RuleVersion;
  parents: string[];
}

export interface ProfileSample {
  /** Arc length along the lane in pixels. */
  s: number;
  /** Intensity 0..255 averaged across the lane strip. */
  intensity: number;
  /** Fraction of pixels at the saturation ceiling. */
  saturatedFraction: number;
  /** Centre pixel of the cross-section at this arc position. */
  at: PixelPoint;
}

export interface ProfilePeak {
  bandId: string;
  sPx: number;
  /** Full width at the local baseline level in migration pixels. */
  widthPx: number;
  prominence: number;
  saturatedFraction: number;
  /** Tail asymmetry: extra area on the far-migration side / total area. */
  tailFraction: number;
  footprint: PixelPoint[];
  center: PixelPoint;
  /** Other peaks whose footprint overlaps this one beyond threshold. */
  overlapWith: string[];
  /** Band-center material this peak was pinned to (manual revision), if any. */
  sourceBandCenterId?: string;
  origin: 'auto' | 'manual';
}

export interface ProfileResult {
  id: ProfileId;
  laneId: string;
  geometryId: LaneGeometryId;
  samples: ProfileSample[];
  peaks: ProfilePeak[];
  inputDigest: string;
  paramsVersion: RuleVersion;
  parents: string[];
}

export type SegmentStatus = 'valid' | 'non_monotonic' | 'missing_band';

export interface CalibrationSegment {
  index: number;
  fromBandId: string;
  toBandId: string;
  fromMassBp: number;
  toMassBp: number;
  /** Migration arc-length interval covered by this segment (px). */
  sFromPx: number;
  sToPx: number;
  status: SegmentStatus;
  reasonCode?: DiagnosticCode;
  /**
   * Valid region projected back into upright pixel space: polygon shared by
   * the ladder lane strip across [sFrom, sTo]. Same-y is meaningless outside
   * it on a smiling gel.
   */
  validPolygon: PixelPoint[];
}

export interface CalibrationResult {
  id: CalibrationId;
  ladderLaneId: string;
  profileId: ProfileId;
  nominalEntryCount: number;
  matchedBands: Array<{ nominalIndex: number; massBp: number; bandId: string; sPx: number }>;
  segments: CalibrationSegment[];
  /** Piecewise-linear log(mass) vs migration arc length. */
  residualBp: Array<{ bandId: string; observedBp: number; fittedBp: number; residualFraction: number }>;
  inputDigest: string;
  paramsVersion: RuleVersion;
  parents: string[];
}

export type InferenceStatus =
  | 'accepted_value'
  | 'candidate'
  | 'interval'
  | 'ambiguous_candidates'
  | 'rejected'
  | 'invalid';

export interface InferenceResult {
  id: InferenceId;
  bandId: string;
  laneId: string;
  calibrationId: CalibrationId;
  profileId: ProfileId;
  geometryId: LaneGeometryId;
  status: InferenceStatus;
  /** Point value when unique and within a valid segment. */
  massBp: number | null;
  /** Interval when the band is saturated/tailed or only bounded. */
  intervalBp: [number, number] | null;
  /** All legal candidates when uniqueness cannot be established. */
  candidatesBp: number[];
  validSegmentIndex: number | null;
  reasonCodes: DiagnosticCode[];
  /** Naive same-y read against the ladder row, kept for the smile narrative. */
  naiveSameYBp: number | null;
  /** sPx used by the lane-curvature aware evaluation. */
  migrationSPx: number;
  inputDigest: string;
  paramsVersion: RuleVersion;
  parents: string[];
}

export type DerivedResult = LaneGeometryResult | ProfileResult | CalibrationResult | InferenceResult;

// ---------------------------------------------------------------------------
// Decisions.
// ---------------------------------------------------------------------------

export type DecisionKind = 'accept' | 'reject' | 'adjust_params' | 'mark_interval';

export interface Decision {
  id: string;
  seq: number;
  branchId: string;
  kind: DecisionKind;
  subjectId: string;
  /** Event position the decision was taken at; conclusions are frozen there. */
  atEventSeq: number;
  paramPatch?: Partial<ParamSet>;
  intervalBp?: [number, number];
  note?: string;
  supersedesDecisionId?: string;
}

// ---------------------------------------------------------------------------
// Event log.
// ---------------------------------------------------------------------------

export type EventType =
  | 'projectCreated'
  | 'materialAdded'
  | 'materialRevised'
  | 'paramsRevised'
  | 'computed'
  | 'decisionMade'
  | 'branchCreated'
  | 'counterexampleRecorded'
  | 'note';

export interface BaseEvent {
  seq: number;
  id: string;
  /** Branch owning this event. */
  branchId: string;
  type: EventType;
  atIso: string;
  parentSeq: number | null;
}

export interface ProjectCreatedEvent extends BaseEvent {
  type: 'projectCreated';
  projectId: string;
  title: string;
  rootBranchId: string;
}

export interface MaterialAddedEvent extends BaseEvent {
  type: 'materialAdded';
  material: Material;
}

export interface MaterialRevisedEvent extends BaseEvent {
  type: 'materialRevised';
  material: Material;
  supersedesMaterialId: string;
}

export interface ParamsRevisedEvent extends BaseEvent {
  type: 'paramsRevised';
  params: ParamSet;
  supersedesParamsEventSeq: number;
  reason: string;
}

export interface ComputedEvent extends BaseEvent {
  type: 'computed';
  results: DerivedResult[];
  diagnostics: Diagnostic[];
  outcome: OutcomeKind;
  /** Stable keys invalidated by the inputs of this compute. */
  invalidatedResultIds: string[];
  budget: { profileCellsBudget: number; profileCellsUsed: number };
}

export interface DecisionMadeEvent extends BaseEvent {
  type: 'decisionMade';
  decision: Decision;
}

export interface BranchCreatedEvent extends BaseEvent {
  type: 'branchCreated';
  branchId: string;
  name: string;
  forkFromSeq: number;
  /** Counterexample perturbation descriptor when this is an archive branch. */
  perturbation?: CounterexamplePerturbation;
}

export interface CounterexampleRecordedEvent extends BaseEvent {
  type: 'counterexampleRecorded';
  entry: CounterexampleEntry;
}

export interface NoteEvent extends BaseEvent {
  type: 'note';
  text: string;
}

export type Event =
  | ProjectCreatedEvent
  | MaterialAddedEvent
  | MaterialRevisedEvent
  | ParamsRevisedEvent
  | ComputedEvent
  | DecisionMadeEvent
  | BranchCreatedEvent
  | CounterexampleRecordedEvent
  | NoteEvent;

// ---------------------------------------------------------------------------
// Counterexample archive: single-source perturbation evidence.
// ---------------------------------------------------------------------------

export type PerturbationKind =
  | 'rotatedImage'
  | 'curvedLane'
  | 'missingLadderBand'
  | 'saturatedRegion'
  | 'overlappingBands'
  | 'nonMonotonicRuler'
  | 'revisionLocalInvalidation';

export interface CounterexamplePerturbation {
  kind: PerturbationKind;
  /** The single direct source that was changed. */
  changedSource: { kind: MaterialKind | 'params'; id: string };
  /** Sources explicitly held constant. */
  heldSources: Array<{ kind: MaterialKind | 'params'; id: string }>;
}

export interface CounterexampleVerdict {
  subjectId: string;
  adopted: boolean;
  reasonCodes: DiagnosticCode[];
  expectedScope: string;
  actualScope: string;
  scopeConfined: boolean;
}

export interface CounterexampleEntry {
  id: string;
  label: string;
  perturbation: CounterexamplePerturbation;
  baselineEventSeq: number;
  verdicts: CounterexampleVerdict[];
  machineEvents: Array<{
    code: DiagnosticCode;
    message: string;
    subject?: { kind: string; id: string };
    validRegionSPx?: [number, number];
  }>;
}
