export const SCHEMA_VERSION = 1;
export const PARAMETER_VERSION = 'gelruler.params.v1';
export const ENGINE_VERSION = 'gelruler.engine.v1';

export type Unit =
  | 'bp'
  | 'kDa'
  | 'nt'
  | 'pixel'
  | 'mm'
  | 'degree'
  | 'second'
  | 'grayvalue'
  | 'unitless';

export interface Quantity {
  value: number;
  unit: Unit;
  originalText?: string;
  rawValue?: string;
}

export interface PointPx {
  x: number;
  y: number;
}

export interface PixelProvenance {
  imageId: string;
  x: number;
  y: number;
  frame: string;
  sourceEventId: string;
  raw?: { x: number; y: number };
}

export type Orientation =
  | 'top-to-bottom'
  | 'bottom-to-top'
  | 'left-to-right'
  | 'right-to-left'
  | 'rotated-90-cw'
  | 'rotated-90-ccw'
  | 'rotated-180'
  | 'unknown';

export interface ExposureInfo {
  iso?: Quantity;
  exposureTime?: Quantity;
  gamma?: Quantity;
  bitDepth: number;
  maxGray: number;
  saturationThreshold: number;
  rawRepresentation?: string;
}

export interface ImageMaterial {
  id: string;
  kind: 'image';
  filename: string;
  mediaType: string;
  width: number;
  height: number;
  sha256: string;
  bytesLength: number;
  orientationRecorded: Orientation;
  orientationSource: 'exif' | 'manual' | 'inferred' | 'unset';
  exposure: ExposureInfo;
  importedAt: string;
  supersededBy?: string;
}

export interface ControlPoint extends PointPx {
  s?: number;
}

export interface LaneGeometry {
  laneId: string;
  points: ControlPoint[];
  lengthPx: number;
  boundingBox: { minX: number; minY: number; maxX: number; maxY: number };
  curved: boolean;
  smileMetric: number;
  validSRange: { sMin: number; sMax: number };
}

export interface LaneMaterial {
  id: string;
  kind: 'lane';
  imageId: string;
  ordinal: number;
  label?: string;
  role: 'sample' | 'ladder';
  geometry: LaneGeometry;
  source: 'auto-candidate' | 'manual' | 'revised';
  sourceEventId: string;
  supersededBy?: string;
  revisions: string[];
}

export interface BandShape {
  widthPx: number;
  heightPx: number;
  circularity?: number;
}

export interface BandEvidence {
  center: PixelProvenance;
  sOnLane: number;
  intensityPeak: Quantity;
  areaPx: number;
  shape: BandShape;
  saturated: boolean;
  saturationFraction?: number;
  smeared: boolean;
  smearExtentPx?: number;
  profile: { s: number; intensity: number }[];
  residuals?: { s: number; fit: number; observed: number; residual: number }[];
}

export interface BandMaterial {
  id: string;
  kind: 'band';
  laneId: string;
  imageId: string;
  evidence: BandEvidence;
  source: 'auto-candidate' | 'manual' | 'revised';
  sourceEventId: string;
  supersededBy?: string;
  revisions: string[];
  overlapGroupId?: string;
}

export interface LadderNominalBand {
  id: string;
  mass: Quantity;
  rank: number;
  matchedBandId?: string;
  missing?: boolean;
}

export interface LadderMaterial {
  id: string;
  kind: 'ladder';
  name: string;
  laneId: string;
  massUnit: Unit;
  nominalBands: LadderNominalBand[];
  sourceEventId: string;
  supersededBy?: string;
  revisions: string[];
  nonMonotonic?: boolean;
}

export type Material = ImageMaterial | LaneMaterial | BandMaterial | LadderMaterial;

export interface CalibrationParams {
  parameterVersion: string;
  model: 'semilog-linear';
  interpolation: 'linear-logm-vs-s';
  extrapolation: 'forbidden';
  monotonicity: 'enforced-strict';
  localScale: 'per-lane';
  saturationThreshold?: number;
  smearBandWidthFactor?: number;
  overlapMinSeparationPx?: number;
  missingBandTolerance?: number;
  allowTransferredScale: boolean;
  notes?: string;
}

export interface CalibrationAnchor {
  nominalBandId: string;
  bandId: string;
  s: number;
  mass: Quantity;
  logMass: number;
  residualLog: number;
}

export interface ValidSegment {
  sMin: number;
  sMax: number;
  anchorIds: string[];
  monotonic: boolean;
}

export interface CalibrationDerivation {
  id: string;
  kind: 'calibration';
  ladderId: string;
  laneId: string;
  paramsVersion: string;
  anchors: CalibrationAnchor[];
  slope: number;
  intercept: number;
  rSquared: number;
  validSegments: ValidSegment[];
  globalResiduals: { bandId: string; s: number; logMassObserved: number; logMassFit: number; residual: number }[];
  status: 'valid' | 'local-only' | 'invalid-non-monotonic' | 'insufficient-anchors' | 'missing-band';
  diagnostics: import('./diagnostics.js').Diagnostic[];
  parentDerivationIds: string[];
  inputSummary: Record<string, unknown>;
  computedAt: string;
}

export type MassStatus =
  | 'determined'
  | 'candidate'
  | 'interval'
  | 'out-of-range'
  | 'unresolved'
  | 'invalid-calibration';

export interface MassCandidate {
  id: string;
  mass: Quantity;
  logMass: number;
  sourceAnchorIds: string[];
  segmentSRange: { sMin: number; sMax: number };
  reason: 'interpolation' | 'overlap-ambiguity' | 'transferred-scale' | 'manual-assignment';
  valid: boolean;
}

export interface MassDerivation {
  id: string;
  kind: 'mass';
  bandId: string;
  laneId: string;
  calibrationId: string;
  status: MassStatus;
  point?: Quantity;
  interval?: { low: Quantity; high: Quantity };
  candidates: MassCandidate[];
  diagnostics: import('./diagnostics.js').Diagnostic[];
  parentDerivationIds: string[];
  inputSummary: Record<string, unknown>;
  computedAt: string;
}

export type Derivation = CalibrationDerivation | MassDerivation;

export type EventType =
  | 'project.created'
  | 'image.imported'
  | 'image.revised'
  | 'orientation.recorded'
  | 'exposure.recorded'
  | 'ladder.placed'
  | 'ladder.revised'
  | 'lane.proposed'
  | 'lane.accepted'
  | 'lane.revised'
  | 'band.proposed'
  | 'band.accepted'
  | 'band.revised'
  | 'auto.detected'
  | 'params.revised'
  | 'decision.accepted'
  | 'decision.rejected'
  | 'decision.overridden'
  | 'derivation.committed'
  | 'annotation.tagged';

export interface EventRecord {
  id: string;
  projectId: string;
  seq: number;
  branchId: string;
  parentEventIds: string[];
  type: EventType;
  timestamp: string;
  actor: string;
  summary: string;
  payload: Record<string, unknown>;
  materialIds: string[];
  derivationIds: string[];
  inputSummary?: Record<string, unknown>;
}

export interface Branch {
  id: string;
  projectId: string;
  name: string;
  parentBranchId?: string;
  forkEventId?: string;
  createdAt: string;
  reason: string;
}

export interface SnapshotView {
  eventId: string;
  branchId: string;
  seq: number;
  images: Record<string, ImageMaterial>;
  lanes: Record<string, LaneMaterial>;
  bands: Record<string, BandMaterial>;
  ladders: Record<string, LadderMaterial>;
  params: CalibrationParams;
  derivations: Record<string, Derivation>;
  activeLaneIdByImage: Record<string, string[]>;
  activeBandIdByLane: Record<string, string[]>;
  decisions: Record<string, DecisionRecord>;
}

export interface DecisionRecord {
  id: string;
  targetType: 'band' | 'lane' | 'ladder' | 'calibration';
  targetId: string;
  verdict: 'accepted' | 'rejected' | 'overridden';
  rationale: string;
  eventId: string;
  branchId: string;
  timestamp: string;
  supersededBy?: string;
}
