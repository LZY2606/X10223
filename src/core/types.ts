import type { Diagnostic, NominalSize } from "./units.js";

// ---------- Geometry (all coordinates carry a frame) ----------

export interface Point {
  x: number; // px from left of the coordinate frame
  y: number; // px from top of the coordinate frame
  frame: string; // e.g. "image#mat_...@rot0" — frames never mix silently
}

export interface Polyline {
  points: Point[];
}

export interface GrayImage {
  width: number;
  height: number;
  pixels: Uint8Array; // row-major grayscale 0..255 (0 = dark band)
  frame: string;
}

// ---------- Immutable source materials ----------

export type MaterialKind =
  | "raw-image"
  | "capture-orientation"
  | "exposure"
  | "ladder-spec"
  | "lane-boundaries"
  | "band-centers";

export interface RawImageMaterial {
  kind: "raw-image";
  role: string; // e.g. "baseline", "rotated-90", "smile", "saturated", ...
  width: number;
  height: number;
  pixelHash: string;
  // pixel-level provenance is the content-addressed blob itself (stored by hash).
  generator?: ImageGeneratorSpec; // deterministic offline synthesis spec
}

export interface ImageGeneratorSpec {
  type: "synthetic-gel-v1";
  width: number;
  height: number;
  seed: number;
  lanes: Array<{
    centerX: number;
    wellY: number;
    curve: { x2: number; y2: number; cx: number; cy: number };
    width: number;
    bands: Array<{ s: number; sizeBp?: number; intensity: number; width: number; saturated?: boolean; smear?: number }>;
  }>;
  exposure: { gamma: number; gain: number; saturationFloor: number };
}

export interface OrientationMaterial {
  kind: "capture-orientation";
  imageRef: string;
  rotation: 0 | 90 | 180 | 270; // degrees clockwise applied to the captured file
  flipped: boolean;
  note?: string;
}

export interface ExposureMaterial {
  kind: "exposure";
  imageRef: string;
  gamma: number;
  gain: number;
  saturationFloor: number; // intensities <= this are treated as saturated
  milliseconds?: number;
}

export interface LadderSpecMaterial {
  kind: "ladder-spec";
  laneRef: string; // stable id of the ladder lane
  nominal: Array<{ bandRef?: string; nominal: NominalSize }>;
}

export interface LaneBoundariesMaterial {
  kind: "lane-boundaries";
  imageRef: string;
  source: "auto" | "human";
  lanes: Array<{
    laneId: string;
    role: "ladder" | "sample";
    center: Point[]; // pixel-level centerline polyline
    left: Point[];
    right: Point[];
  }>;
}

export interface BandCentersMaterial {
  kind: "band-centers";
  imageRef: string;
  source: "auto" | "human";
  bands: Array<{
    bandId: string;
    laneId: string;
    center: Point;
    observed?: { peak: number; widthPx: number; saturated: boolean; smear: number; area: number };
  }>;
}

export type Material =
  | RawImageMaterial
  | OrientationMaterial
  | ExposureMaterial
  | LadderSpecMaterial
  | LaneBoundariesMaterial
  | BandCentersMaterial;

// ---------- Events: append-only decision/derivation log ----------

export type EventType =
  | "project.created"
  | "material.ingested"
  | "lanes.auto-traced"
  | "lanes.revised"
  | "bands.auto-detected"
  | "bands.revised"
  | "ladder.assigned"
  | "ladder.band-missing"
  | "calibration.computed"
  | "mw.inferred"
  | "candidate.flagged"
  | "decision.accepted"
  | "decision.rejected"
  | "decision.conflict"
  | "rules.revised"
  | "source.replaced"
  | "invalid.non-monotonic"
  | "invalid.local-revision";

export interface Event<P = unknown> {
  id: string; // stable, content-derived
  seq: number; // global monotonic order, assigned on append
  projectId: string;
  type: EventType;
  clock: number; // logical lamport clock (no wall clock dependence)
  parents: string[]; // explicit parent dependency event ids
  ruleVersion: string; // ruleset that produced/validated this event
  inputSummary: Record<string, unknown>; // hash-ish digest of inputs
  payload: P;
  diagnostics: Diagnostic[];
  adopted: boolean; // adopted vs explicitly not-adopted result
  branchId: string;
}

// ---------- Derived results ----------

export interface LaneGeometry {
  laneId: string;
  role: "ladder" | "sample";
  frame: string;
  centerCoef: { a: number; b: number; c: number }; // x = a*y^2 + b*y + c
  centerRmsResidual: number;
  widthPx: number;
  lengthPx: number;
  validS: { start: number; end: number };
}

export interface ProfilePoint {
  s: number; // arc-length coordinate in px-arc
  intensity: number; // 0..255
}

export interface BandObservation {
  bandId: string;
  laneId: string;
  frame: string;
  center: Point;
  s: number;
  peak: number;
  widthPx: number;
  area: number;
  saturated: boolean;
  smear: number;
  status: "unique" | "candidate" | "interval" | "unresolved";
  clusterWith?: string[];
}

export interface CalibrationSegment {
  id: string;
  sLow: number;
  sHigh: number;
  bpLow: number;
  bpHigh: number;
  monotonic: boolean;
}

export interface RulerResult {
  rulerId: string;
  laneId: string;
  frame: string;
  model: "piecewise-linear-log-bp-vs-arc";
  points: Array<{ bandId: string; s: number; bp: number; nominal: string }>;
  segments: CalibrationSegment[];
  validS: { start: number; end: number };
  residuals: Array<{ bandId: string; dlogBp: number }>;
  status: "valid" | "non-monotonic" | "insufficient-points";
  reason?: string;
  diagnostics: Diagnostic[];
}

export interface MwResult {
  bandId: string;
  laneId: string;
  rulerId: string;
  status: "unique" | "interval" | "candidate" | "out-of-range" | "unresolved";
  mw?: { low: number; high: number; best: number; unit: "bp" };
  segmentId?: string;
  s: number;
  valid: boolean;
  invalidReason?: string;
  diagnostics: Diagnostic[];
  provenance: {
    rulerEventId: string;
    calibrationPointIds: string[];
    bandMaterialId: string;
    ruleVersion: string;
  };
}

export interface DecisionRecord {
  decisionId: string;
  bandId: string;
  action: "accept" | "reject" | "adjust";
  mwBp?: number;
  rationale: string;
  parentEventId: string;
}

export const LATEST_RULE_VERSION = "rules.gel.v2.0";
export const DEFAULT_RULE_VERSION = "rules.gel.v1.0";
