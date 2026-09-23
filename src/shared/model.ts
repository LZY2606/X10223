import type { CoordinateFrame } from './errors.js';

export type { CoordinateFrame };

export interface WithUnit<T> {
  value: T;
  unit: string;
  raw?: string;
  diagnostic?: string;
}

export type Vec2 = { x: number; y: number };

export interface PixelProvenance {
  blobId: string;
  frame: CoordinateFrame;
  x: number;
  y: number;
  precisionPx: number;
}

export interface CurvePoint {
  x: number;
  y: number;
}

export interface LaneGeometry {
  laneId: string;
  label: string;
  wellSide: 'top' | 'bottom';
  left: CurvePoint[];
  center: CurvePoint[];
  right: CurvePoint[];
  source: PixelProvenance[];
}

export type ExposureStatus = 'ok' | 'saturated' | 'underexposed';

export interface BandObservation {
  bandId: string;
  laneId: string;
  center: CurvePoint;
  widthPx: number;
  height: number;
  fit: GaussianFit;
  exposure: ExposureStatus;
  saturatedPixels: number;
  tailing: 'none' | 'right' | 'left';
  overlapWith?: string[];
  source: PixelProvenance;
}

export interface GaussianFit {
  baseline: number;
  amplitude: number;
  mu: number;
  sigma: number;
  rmsResidual: number;
  samples: number;
}

export interface LadderRung {
  rungId: string;
  nominalBp: WithUnit<number | null>;
  bandId: string | null;
  observed: boolean;
  source: PixelProvenance[];
}

export interface ImageMaterial {
  blobId: string;
  mediaType: 'image/png';
  width: number;
  height: number;
  sha256: string;
  bytes: number;
}

export interface CaptureOrientation {
  rotationCw: 0 | 90 | 180 | 270;
  flipped: boolean;
  wellSide: 'top' | 'bottom';
  rawLabel: string;
}

export interface ExposureSetting {
  exposureMs: WithUnit<number | null>;
  gain: WithUnit<number | null>;
  saturationLevel: number;
  rawText: string;
}

export type ParameterName =
  | 'saturationThreshold'
  | 'tailingAsymmetry'
  | 'overlapSeparationPx'
  | 'extrapolationBudgetMm'
  | 'bandSnapping';

export interface ParameterRevision {
  name: ParameterName;
  oldValue: number | string | boolean | null;
  newValue: number | string | boolean | null;
  reason: string;
}

export type DecisionKind = 'accept' | 'reject' | 'candidate' | 'interval';
export type DecisionTarget =
  | { type: 'molecularWeight'; bandId: string }
  | { type: 'laneDetection'; laneId: string }
  | { type: 'bandDetection'; bandId: string }
  | { type: 'rungAssignment'; rungId: string }
  | { type: 'calibration'; laneId: string };

export interface Event {
  id: string;
  seq: number;
  branch: string;
  parentEventId: string | null;
  timestamp: string;
  kind:
    | 'project-created'
    | 'image-imported'
    | 'capture-orientation-recorded'
    | 'exposure-recorded'
    | 'ladder-spec-recorded'
    | 'lane-geometry-recorded'
    | 'bands-recorded'
    | 'rung-assigned'
    | 'rung-withheld'
    | 'parameter-revised'
    | 'decision-recorded'
    | 'derivation-recorded'
    | 'branch-created';
  actor: 'system' | 'reviewer';
  payload: Record<string, unknown>;
  inputSummary?: Record<string, unknown>;
  paramVersionId?: string | null;
  parents?: string[];
}

export interface Branch {
  id: string;
  name: string;
  parentBranch: string | null;
  forkedFromEventId: string | null;
  headEventId: string | null;
  createdAt: string;
}

export interface DerivationRecord {
  derivationId: string;
  kind:
    | 'lane-detection'
    | 'band-detection'
    | 'rung-association'
    | 'calibration'
    | 'molecular-weight'
    | 'local-invalidation';
  inputSummary: Record<string, unknown>;
  paramVersionId: string;
  parents: string[];
  outputDigest: string;
  status: 'ok' | 'diagnostics' | 'impossible';
  affectedObjects: string[];
}

export interface Diagnostic {
  code: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  path?: string;
  bandId?: string;
  laneId?: string;
  rungId?: string;
  validRegion?: { axis: 's'; from: number; to: number; unit: string };
}

export interface CalibrationSegment {
  rungA: string;
  rungB: string;
  sA: number;
  sB: number;
  bpA: number;
  bpB: number;
  slope: number;
  intercept: number;
  valid: boolean;
  reason?: string;
}

export interface LocalRuler {
  laneId: string;
  segments: CalibrationSegment[];
  validRegion: { fromS: number; toS: number; unit: string };
  extrapolationBudget: { before: number; after: number; unit: string };
  diagnostics: Diagnostic[];
}

export type MwStatus = 'unique' | 'candidate-set' | 'interval' | 'outside-ruler' | 'impossible';

export interface MolecularWeightResult {
  bandId: string;
  laneId: string;
  s: number;
  status: MwStatus;
  bp: number | null;
  intervalBp?: { low: number; high: number };
  candidatesBp?: number[];
  segmentRef?: { fromRung: string; toRung: string; laneId: string };
  validRegion: { fromS: number; toS: number };
  diagnostics: Diagnostic[];
  derivationId: string;
}

export interface BranchView {
  branchId: string;
  atEventId: string;
  image?: ImageMaterial;
  orientation?: CaptureOrientation;
  exposure?: ExposureSetting;
  ladderRungs: LadderRung[];
  ladderLaneId: string | null;
  lanes: LaneGeometry[];
  bands: BandObservation[];
  rulers: LocalRuler[];
  molecularWeights: MolecularWeightResult[];
  parameters: Record<ParameterName, number | string | boolean>;
  paramVersionId: string;
  decisions: { target: DecisionTarget; kind: DecisionKind; note?: string; atEventId: string }[];
  diagnostics: Diagnostic[];
  derivations: DerivationRecord[];
  acceptedBandIds: string[];
  rejectedBandIds: string[];
}

export interface BundleManifest {
  format: 'gel-workbench-bundle';
  formatVersion: 1;
  projectId: string;
  name: string;
  exportedAt: string;
  eventCount: number;
  branchCount: number;
  blobCount: number;
  bodyDigest: string;
}

export interface Bundle {
  manifest: BundleManifest;
  project: { id: string; name: string; createdAt: string; description: string };
  branches: Branch[];
  events: Event[];
  blobs: { blobId: string; mediaType: string; base64: string }[];
}
