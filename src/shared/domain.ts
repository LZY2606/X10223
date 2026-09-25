import type { Qty } from "./quantities.js";
import type { ParamPack } from "./params.js";

export type FrameRef = "raw" | "rotated";

export interface Point {
  x: number;
  y: number;
}

export interface PixelProvenance {
  frame: FrameRef;
  origin: "auto" | "manual";
  detectorVersion: string | null;
  sourceImageId: string;
  pixelUncertainty: number;
}

export type MaterialType =
  | "image"
  | "orientation"
  | "exposure"
  | "ladder-spec"
  | "lane"
  | "band";

export interface ImageMaterial {
  kind: "image";
  id: string;
  frame: FrameRef;
  mediaType: "image/png";
  blobId: string;
  width: number;
  height: number;
  sha256: string;
  capturedAt: string | null;
  derivedFromImageId: string | null;
  transform: { type: "rotate"; clockwiseDegrees: number } | null;
}

export interface OrientationMaterial {
  kind: "orientation";
  id: string;
  imageId: string;
  frame: FrameRef;
  clockwiseDegrees: Qty;
  timeBase: string | null;
}

export interface ExposureMaterial {
  kind: "exposure";
  id: string;
  imageId: string;
  frame: FrameRef;
  exposureDuration: Qty;
  gainRaw: string;
  maxIntensity: number;
  saturationLevelRaw: string;
  pixelValueRange: [number, number];
  coordinateBasis: string;
}

export interface LadderBandNominal {
  ordinal: number;
  present: boolean;
  nominal: Qty;
}

export interface LadderSpecMaterial {
  kind: "ladder-spec";
  id: string;
  name: string;
  dimension: "mass-fragment" | "mass-protein";
  bands: LadderBandNominal[];
  rawPreservationNote: string;
}

export interface LaneMaterial {
  kind: "lane";
  id: string;
  imageId: string;
  frame: FrameRef;
  laneOrdinal: number;
  role: "ladder" | "sample";
  ladderSpecId: string | null;
  polyline: Point[];
  widthPx: number;
  provenance: PixelProvenance;
  baseLaneId: string | null;
}

export interface BandMaterial {
  kind: "band";
  id: string;
  laneId: string;
  imageId: string;
  frame: FrameRef;
  center: Point;
  centerUncertaintyPx: number;
  widthPx: number;
  heightPx: number;
  peakIntensity: number;
  saturated: boolean;
  tailing: "none" | "right" | "left";
  overlapGroupId: string | null;
  provenance: PixelProvenance;
}

export type Material =
  | ImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderSpecMaterial
  | LaneMaterial
  | BandMaterial;

export type DecisionVerb = "accept" | "reject" | "revise" | "supersede";
export type DecisionTargetKind = "band-mw" | "lane" | "ladder-band" | "calibration";

export interface DecisionEvent {
  kind: "decision";
  id: string;
  seq: number;
  branch: string;
  parentEventId: string | null;
  at: string;
  verb: DecisionVerb;
  targetKind: DecisionTargetKind;
  targetId: string;
  valueRaw: string | null;
  rationale: string;
  author: string;
  paramsVersion: string;
  derivedFromComputationId: string | null;
}

export interface ParamRevisionEvent {
  kind: "param-revision";
  id: string;
  seq: number;
  branch: string;
  parentEventId: string | null;
  at: string;
  fromParamsVersion: string;
  toParamsVersion: string;
  patch: Record<string, unknown>;
  rationale: string;
  author: string;
}

export interface RetractionEvent {
  kind: "retraction";
  id: string;
  seq: number;
  branch: string;
  parentEventId: string | null;
  at: string;
  retractedMaterialIds: string[];
  replacementMaterialIds: string[];
  reason: string;
  author: string;
}

export interface BranchEvent {
  kind: "branch";
  id: string;
  seq: number;
  branch: string;
  parentEventId: string | null;
  at: string;
  newBranch: string;
  fromEventId: string;
  author: string;
}

export type ProjectEvent = DecisionEvent | ParamRevisionEvent | RetractionEvent | BranchEvent;

export type Severity = "info" | "warning" | "error";

export interface Diagnostic {
  code: string;
  severity: Severity;
  message: string;
  at: { frame: FrameRef; x?: number; y?: number; laneId?: string; bandId?: string; segmentId?: string; field?: string };
}

export type BandInferenceStatus =
  | "accepted"
  | "rejected"
  | "candidate"
  | "interval"
  | "indeterminate"
  | "out-of-range";

export interface CalibrationSegment {
  id: string;
  sLow: number;
  sHigh: number;
  logBaseLow: number;
  logBaseHigh: number;
  lowOrdinal: number;
  highOrdinal: number;
  valid: boolean;
  monotonic: boolean;
  gapBridged: boolean;
  sourceLadderBandIds: string[];
}

export interface LadderFit {
  id: string;
  ladderLaneId: string;
  model: "log-linear-global" | "log-linear-piecewise";
  globalSlope: number | null;
  globalIntercept: number | null;
  rSquared: number | null;
  residuals: { ladderBandId: string; s: number; observedLogBase: number; fittedLogBase: number; residual: number }[];
  segments: CalibrationSegment[];
  validS: [number, number] | null;
  diagnostics: Diagnostic[];
}

export interface LaneCalibration {
  id: string;
  laneId: string;
  fromLadderLaneId: string;
  ladderFitId: string;
  segments: CalibrationSegment[];
  validS: [number, number] | null;
  anchorS: number[];
}

export interface BandInference {
  id: string;
  bandId: string;
  laneCalibrationId: string;
  segmentId: string | null;
  sAlongLane: number;
  status: BandInferenceStatus;
  estimate: Qty | null;
  interval: [Qty, Qty] | null;
  candidates: Qty[];
  uncertaintyBase: number | null;
  diagnostics: Diagnostic[];
  evidenceCodes: string[];
}

export interface ComputationRecord {
  id: string;
  inputDigest: string;
  paramsVersion: string;
  parentDependencyIds: string[];
  rulePackVersion: string;
  fits: LadderFit[];
  laneCalibrations: LaneCalibration[];
  bandInferences: BandInference[];
  diagnostics: Diagnostic[];
}

export interface Adjudication {
  inferenceId: string;
  verb: DecisionVerb;
  status: BandInferenceStatus | "manual";
  valueRaw: string | null;
  decisionId: string;
  author: string;
  rationale: string;
  at: string;
}

export interface ProjectState {
  projectId: string;
  name: string;
  branch: string;
  branches: Record<string, string | null>;
  atEventId: string | null;
  seq: number;
  headSeq: number;
  params: ParamPack;
  paramsVersion: string;
  activeFrame: FrameRef;
  materials: Record<string, Material>;
  retractedMaterialIds: string[];
  events: ProjectEvent[];
  computation: ComputationRecord | null;
  adjudications: Record<string, Adjudication>;
}

export interface ImportFailure {
  outcome: "format-corrupt" | "semantic-unsolvable" | "budget-exhausted";
  code: string;
  message: string;
  position: string | null;
}
