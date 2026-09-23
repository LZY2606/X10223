// 胶道标尺：核心领域类型
// 分层原则：不可变材料(materials) 与 可修改决定(events) 严格分离；
// 所有计算结果(results)记录输入摘要、参数版本与父级依赖。

export type Unit = 'bp' | 'kDa' | 'px' | 'um' | 'ms' | 'a.u.';
export type RefFrame = 'raw_image' | 'working_image';

export interface QValue {
  value: number | null;
  unit: Unit;
  raw?: string;
  convertError?: string;
}

export interface Vec { x: number; y: number; }

export interface PixelProvenance {
  frame: RefFrame;
  point: Vec;
  sourceMaterialId: string;
  sourceKind: 'gel_image' | 'lane_boundary' | 'band_center' | 'ladder_point';
  uncertaintyPx?: number;
}

export type Orientation = 'as_imported' | 'rotate_cw_90' | 'rotate_180' | 'rotate_ccw_90';
export type ExposureMode = 'standard' | 'saturated';

export interface GelImage {
  id: string;
  kind: 'material';
  sha256: string;
  blobKey: string;
  width: number;
  height: number;
  orientation: Orientation;
  exposure: {
    mode: ExposureMode;
    value: QValue;
    saturationThreshold: QValue;
    rawRepresentation: string;
  };
  captureMeta: {
    camera: string;
    timestampUtc: string;
    rawRepresentation: Record<string, string>;
  };
  importedAt: string;
}

export interface LadderPoint {
  id: string;
  nominal: QValue;
  expectedOrder: number;
  observed?: BandCenter;
  missing?: boolean;
}

export interface LadderSpec {
  id: string;
  kind: 'material';
  name: string;
  unit: Unit;
  points: LadderPoint[];
  rawRepresentation: string;
}

export interface LaneBoundary {
  id: string;
  kind: 'material';
  laneIndex: number;
  centerline: Vec[];
  leftEdge?: Vec[];
  rightEdge?: Vec[];
  frame: RefFrame;
  originImageId: string;
  origin: 'auto_candidate' | 'manual' | 'derived_from_rotation';
}

export interface BandObservation {
  id: string;
  laneId: string;
  s: number; // 沿泳道中心线的弧长(px, working frame)
  anchorPoint: Vec; // working frame
  provenance: PixelProvenance;
  intensity: QValue;
  saturated: boolean;
  smear: boolean;
  origin: 'auto_candidate' | 'manual';
}

export type Material = GelImage | LadderSpec | LaneBoundary;

export type EventType =
  | 'project_created'
  | 'image_imported'
  | 'ladder_imported'
  | 'auto_lanes'
  | 'auto_bands'
  | 'lane_revised'
  | 'band_revised'
  | 'ladder_assignment_revised'
  | 'rotation_applied'
  | 'parameter_revised'
  | 'candidate_accepted'
  | 'candidate_rejected'
  | 'conflicting_decision'
  | 'import_rejected'
  | 'branch_created'
  | 'result_invalidated';

export interface GelEvent {
  id: string;
  projectId: string;
  branchId: string;
  seq: number;
  clock: number;
  type: EventType;
  message: string;
  parentEventId: string | null;
  at: string;
  payload: Record<string, unknown>;
  invalidates?: string[];
  inputSummary: Record<string, unknown>;
  parameterVersion: number;
}

export type DiagnosticCode =
  | 'ROTATION_APPLIED'
  | 'BENT_LANE'
  | 'MISSING_BAND'
  | 'SATURATED_BAND'
  | 'BAND_OVERLAP'
  | 'SMEAR_BAND'
  | 'NON_MONOTONIC_RULER'
  | 'OUTSIDE_VALID_REGION'
  | 'EXTRAPOLATION_REFUSED'
  | 'INCOMPLETE_INPUT'
  | 'BUDGET_EXHAUSTED'
  | 'FORMAT_CORRUPT'
  | 'SEMANTIC_UNRESOLVABLE'
  | 'LOCAL_RULER_RETIRED'
  | 'CONFLICTING_DECISION';

export type Severity = 'info' | 'warning' | 'error';

export interface Diagnostic {
  code: DiagnosticCode;
  severity: Severity;
  message: string;
  position?: PixelProvenance;
  affectedObjectIds: string[];
  scenario?: string;
}

export type OutcomeClass = 'budget_exhausted' | 'format_corrupt' | 'semantic_unresolvable' | 'ok';

export interface ValidSegment {
  ladderPointIds: [string, string];
  sStart: number;
  sEnd: number;
  valid: boolean;
  reason?: DiagnosticCode;
}

export interface CalibrationResult {
  id: string;
  kind: 'calibration';
  laneId: string;
  ladderSpecId: string;
  imageId: string;
  paramVersion: number;
  parentEventId: string;
  parents: string[];
  inputSummary: Record<string, unknown>;
  validSegments: ValidSegment[];
  validRegion: { sMin: number; sMax: number };
  adopted: boolean;
  outcome: OutcomeClass;
  diagnostics: Diagnostic[];
  createdAt: string;
}

export interface MwCandidate {
  id: string;
  mw: QValue;
  s: number;
  status: 'unique' | 'candidate' | 'interval' | 'indeterminate';
  interval?: { low: QValue; high: QValue };
  altCandidates?: QValue[];
  segmentId?: string;
  evidenceBandIds: string[];
  ladderPointIds: string[];
  valid: boolean;
  invalidReason?: DiagnosticCode;
}

export interface MwResult {
  id: string;
  kind: 'mw_inference';
  laneId: string;
  calibrationId: string;
  paramVersion: number;
  parentEventId: string;
  parents: string[];
  inputSummary: Record<string, unknown>;
  candidates: MwCandidate[];
  adopted: boolean;
  outcome: OutcomeClass;
  diagnostics: Diagnostic[];
  createdAt: string;
}

export interface DetectionResult {
  id: string;
  kind: 'detection';
  imageId: string;
  paramVersion: number;
  parentEventId: string;
  parents: string[];
  inputSummary: Record<string, unknown>;
  lanes: LaneBoundary[];
  bands: BandObservation[];
  adopted: boolean;
  outcome: OutcomeClass;
  diagnostics: Diagnostic[];
  createdAt: string;
}

export interface RotationResult {
  id: string;
  kind: 'rotation';
  imageId: string;
  from: Orientation;
  to: Orientation;
  paramVersion: number;
  parentEventId: string;
  parents: string[];
  inputSummary: Record<string, unknown>;
  projectedLaneIds: string[];
  adopted: boolean;
  outcome: OutcomeClass;
  diagnostics: Diagnostic[];
  createdAt: string;
}

export interface InvalidationResult {
  id: string;
  kind: 'invalidation';
  paramVersion: number;
  parentEventId: string;
  parents: string[];
  inputSummary: Record<string, unknown>;
  retiredResultIds: string[];
  scope: 'global' | 'local';
  affectedLaneIds: string[];
  adopted: boolean;
  outcome: OutcomeClass;
  diagnostics: Diagnostic[];
  createdAt: string;
}

export type ComputedResult =
  | DetectionResult
  | CalibrationResult
  | MwResult
  | RotationResult
  | InvalidationResult;

export interface Branch {
  id: string;
  name: string;
  parentBranchId: string | null;
  forkEventId: string | null;
  createdAt: string;
  note?: string;
}

export interface ParameterSet {
  version: number;
  detection: {
    intensityThreshold: number;
    minBandSpacingPx: number;
    overlapBandHalfWidthPx: number;
    saturationLevel: number;
    maxCandidatesPerPeak: number;
  };
  calibration: {
    interpolation: 'semilog_linear';
    refuseExtrapolation: boolean;
  };
  budget: {
    maxPixels: number;
    maxBands: number;
    maxResults: number;
  };
}

export interface ProjectState {
  projectId: string;
  name: string;
  createdAt: string;
  branches: Record<string, Branch>;
  heads: Record<string, string>;
  events: GelEvent[];
  materials: {
    images: Record<string, GelImage>;
    ladders: Record<string, LadderSpec>;
    lanes: Record<string, LaneBoundary>;
    bands: Record<string, BandObservation>;
  };
  results: Record<string, ComputedResult>;
  params: ParameterSet;
  clock: number;
}

export interface CasepackScenario {
  id: string;
  title: string;
  branch: string;
  trigger: string;
  expects: DiagnosticCode[];
}

export interface BundleHeader {
  format: 'GELPRJ01';
  projectId: string;
  name: string;
  createdAt: string;
  exportedAt: string;
  manifestSha256: string;
}
