// ---------------------------------------------------------------------------
// Domain model for the gel / lane / band calibration workbench.
// Layering rule: IMMUTABLE MATERIAL (captured pixel-level source, original
// representation preserved) vs DERIVED / DECISIONS (computed or human, always
// carrying input digest, parameter version and parent dependencies).
// ---------------------------------------------------------------------------

/** A domain quantity: value + unit + coordinate/time basis. Never bare numbers. */
export interface Quantity<U extends string = string> {
  value: number;
  unit: U;
  /** Coordinate frame or time basis this value is expressed in. */
  frame: FrameId;
}

export type FrameId =
  | 'image_raw'        // pixels of the stored (possibly rotated) image
  | 'image_canonical'  // pixels after orientation normalization (migration runs +y)
  | 'bp'               // base pairs
  | 'kDa'              // kilodaltons
  | 'ms'               // exposure time
  | 'dimensionless';

export interface Interval<U extends string = string> {
  lo: Quantity<U>;
  hi: Quantity<U>;
  /** Why this is an interval instead of a point estimate. */
  reason: string;
}

// --- Diagnostics -----------------------------------------------------------

export type DiagnosticCode =
  | 'INPUT_INCOMPLETE'      // missing required material, with location
  | 'FORMAT_CORRUPT'        // bytes/JSON unparseable or checksum mismatch
  | 'SEMANTIC_UNSOLVABLE'   // well-formed but no valid answer (e.g. non-monotonic ruler)
  | 'RESOURCE_BUDGET_EXHAUSTED';

export interface Diagnostic {
  code: DiagnosticCode;
  /** JSON-pointer-ish location of the offending input, e.g. "ladder.nominals[3]". */
  location: string;
  message: string;
}

export class DomainError extends Error {
  constructor(
    public readonly code: DiagnosticCode,
    public readonly diagnostic: Diagnostic,
  ) {
    super(`${code} @ ${diagnostic.location}: ${diagnostic.message}`);
    this.name = 'DomainError';
  }
}

export const incomplete = (location: string, message: string) =>
  new DomainError('INPUT_INCOMPLETE', { code: 'INPUT_INCOMPLETE', location, message });
export const corrupt = (location: string, message: string) =>
  new DomainError('FORMAT_CORRUPT', { code: 'FORMAT_CORRUPT', location, message });
export const unsolvable = (location: string, message: string) =>
  new DomainError('SEMANTIC_UNSOLVABLE', { code: 'SEMANTIC_UNSOLVABLE', location, message });
export const budgetExhausted = (location: string, message: string) =>
  new DomainError('RESOURCE_BUDGET_EXHAUSTED', { code: 'RESOURCE_BUDGET_EXHAUSTED', location, message });

// --- Immutable material ----------------------------------------------------

export type Orientation = 0 | 90 | 180 | 270;

export interface GelImageMaterial {
  id: string;                 // mat_image_<hash>
  kind: 'image';
  /** Raw bytes, base64. Original representation preserved; never normalized. */
  pngBase64: string;
  widthPx: number;
  heightPx: number;
  sha256: string;
  /** Capture direction: rotation of the stored image relative to canonical
   *  electrophoresis orientation (wells top, migration downward). */
  orientation: Orientation;
  /** Capture exposure, original representation kept verbatim. */
  exposure: { value: number; unit: 'ms' | 's' | 'auto'; raw: string };
  label: string;
}

export interface LadderNominal {
  /** Nominal size in original representation; normalization happens in derived layer. */
  value: number;
  unit: 'bp' | 'kDa';
  raw: string;
}

export interface LadderMaterial {
  id: string;                 // mat_ladder_<hash>
  kind: 'ladder';
  laneId: string;
  nominals: LadderNominal[];  // declared sizes, top->bottom in canonical frame
  /** Declared source-level missing ladder bands (index into nominals). */
  missingIndexes: number[];
  label: string;
}

export interface LaneBoundaryMaterial {
  id: string;                 // mat_lane_<hash>
  kind: 'lane';
  laneId: string;
  /** Centerline polyline in RAW image pixels: pixel-level provenance. */
  centerlinePx: Array<{ x: number; y: number }>;
  /** Half-width of the lane in raw pixels. */
  halfWidthPx: number;
  label: string;
}

export interface BandCenterMaterial {
  id: string;                 // mat_band_<hash>
  kind: 'band';
  laneId: string;
  bandKey: string;            // human-facing key, e.g. "L1-b3"
  role: 'ladder' | 'sample';
  /** For role='ladder': index into the lane ladder's nominals (robust to gaps). */
  ladderIndex?: number;
  /** Band center in RAW image pixels: pixel-level provenance. */
  centerPx: { x: number; y: number };
  /** Optional observed quality flags from capture/annotation. */
  saturated?: boolean;
  smeared?: boolean;
  overlapGroup?: string;      // bands sharing a group id overlap each other
  label: string;
}

export type Material =
  | GelImageMaterial
  | LadderMaterial
  | LaneBoundaryMaterial
  | BandCenterMaterial;

// --- Parameters (versioned rules) ------------------------------------------

export interface CalibrationParams {
  version: string;            // e.g. "calib/1.0.0", "calib/1.1.0"
  model: 'log-linear-piecewise';
  /** Max fraction of dynamic range considered saturated. */
  saturationThreshold: number;
  /** Minimum ladder points required for a usable local segment. */
  minLadderPoints: number;
  /** Gap (in ladder index) beyond which interpolation is flagged as extended. */
  maxBridgedGap: number;
  /** Resource budget: max candidate evaluations per inference batch. */
  evalBudget: number;
  hash?: string;              // par_<hash>, filled by store
}

// --- Derived: calibration ---------------------------------------------------

export interface LadderPoint {
  nominal: Quantity<'bp' | 'kDa'>;
  /** Canonical migration distance from well (px). */
  migrationPx: Quantity<'px'>;
  ladderIndex: number;
  bandRef: string;            // material id of the band center used
}

export interface CalibrationSegment {
  id: string;                 // val_... stable id
  laneId: string;
  lo: LadderPoint;
  hi: LadderPoint;
  slopeLogPerPx: number;
  /** Valid region of this local ruler, canonical px. Same pixel height outside
   *  a lane's segments is NOT the same molecular weight. */
  validRegion: { loPx: number; hiPx: number; frame: 'image_canonical' };
  bridgedGap: boolean;        // true if a missing ladder band was bridged
}

export type CalibrationStatus =
  | { state: 'ok'; segments: CalibrationSegment[]; points: LadderPoint[] }
  | { state: 'degraded'; segments: CalibrationSegment[]; points: LadderPoint[]; diagnostics: Diagnostic[] }
  | { state: 'failed'; diagnostic: Diagnostic };

// --- Derived: inference -----------------------------------------------------

export type InferenceVerdict =
  | { type: 'value'; mw: Quantity<'bp' | 'kDa'>; segmentId: string }
  | { type: 'interval'; interval: Interval<'bp' | 'kDa'>; segmentId: string }
  | { type: 'candidates'; candidates: Array<Quantity<'bp' | 'kDa'>>; reason: string }
  | { type: 'invalid'; diagnostic: Diagnostic };

export interface BandInference {
  id: string;                 // val_... stable display identity
  bandRef: string;            // BandCenterMaterial id
  bandKey: string;
  laneId: string;
  verdict: InferenceVerdict;
  /** Pixel-level provenance back to the band center. */
  centerPx: { x: number; y: number; frame: 'image_raw' };
  migrationPx: Quantity<'px'>;
  residuals: { ladderPointRef: string; residualLog: number }[];
  /** Parent dependencies: material ids + params hash this result came from. */
  parents: string[];
  paramsHash: string;
  inputDigest: string;        // sha256 over canonical input set
}

// --- Events (append-only truth) ----------------------------------------------

export type EventType =
  | 'material.registered'
  | 'material.superseded'
  | 'params.activated'
  | 'inference.computed'
  | 'decision.accept'
  | 'decision.reject'
  | 'decision.adjust'
  | 'decision.conflict'
  | 'diagnostic.raised'
  | 'branch.created';

export interface GelEvent {
  id: string;                 // evt_<seq> per branch, stable after export/import
  branch: string;
  seq: number;
  type: EventType;
  /** Parent event ids this event depends on (dependency graph, not just time). */
  parents: string[];
  payload: Record<string, unknown>;
  /** Deterministic content hash — identical logical event => identical hash. */
  hash: string;
}

export interface Decision {
  eventId: string;
  targetValueId: string;      // the display value being judged
  action: 'accept' | 'reject' | 'adjust';
  adjusted?: InferenceVerdict;
  note: string;
  actor: string;
}

// --- Project state (derived view, replayable) --------------------------------

export interface ProjectState {
  projectId: string;
  materials: Material[];
  params: CalibrationParams;
  inferences: BandInference[];
  decisions: Decision[];
  diagnostics: Diagnostic[];
  calibration: Record<string, CalibrationStatus>; // per laneId
  headEvent: string | null;
}
