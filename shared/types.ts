export type Unit = 'px' | 'bp' | 'ms' | 's' | 'log10bp' | 'deg' | 'gray8' | 'count';

export interface Quantity {
  value: number;
  unit: Unit;
  basis?: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  location: string;
  severity: 'error' | 'warning';
}

export type FailureKind = 'BUDGET_EXHAUSTED' | 'FORMAT_CORRUPT' | 'SEMANTIC_UNSOLVABLE';

export type Result<T> =
  | { status: 'ok'; value: T; diagnostics: Diagnostic[] }
  | { status: 'failed'; kind: FailureKind; diagnostics: Diagnostic[] };

export function ok<T>(value: T, diagnostics: Diagnostic[] = []): Result<T> {
  return { status: 'ok', value, diagnostics };
}

export function failed<T>(kind: FailureKind, diagnostics: Diagnostic[]): Result<T> {
  return { status: 'failed', kind, diagnostics };
}

export class FormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatError';
  }
}

export interface AnalysisParams {
  version: string;
  fit: 'linear' | 'quadratic';
  saturationThreshold: number;
  overlapMinSeparationPx: number;
  tailingAsymmetryRatio: number;
  maxPeaksPerLane: number;
  extrapolation: 'refuse' | 'flag';
  peakProminence: number;
}

export const PARAMS_V1: AnalysisParams = {
  version: 'params-v1',
  fit: 'linear',
  saturationThreshold: 250,
  overlapMinSeparationPx: 10,
  tailingAsymmetryRatio: 2.2,
  maxPeaksPerLane: 24,
  extrapolation: 'refuse',
  peakProminence: 28,
};

export const PARAMS_V2: AnalysisParams = {
  ...PARAMS_V1,
  version: 'params-v2',
  fit: 'quadratic',
};

export interface LaneGeom {
  laneId: string;
  role: 'ladder' | 'sample';
  xPx: number;
  widthPx: number;
  curve: { a: number; b: number; c: number };
}

export interface GelImageContent {
  width: number;
  height: number;
  grayB64: string;
  pixelBasis: 'row-major-top-left-gray8';
}

export interface CaptureContent {
  orientationDeg: 0 | 90 | 180 | 270;
  exposure?: Quantity;
  rawExposure?: string;
}

export interface LadderContent {
  name: string;
  sizesBp: number[];
  rawSizes?: string[];
  basis: 'bp';
}

export interface LaneBoundariesContent {
  lanes: LaneGeom[];
  basis: 'image-px-top-left';
}

export interface BandCenter {
  bandId: string;
  xPx: number;
  yPx: number;
  origin: 'auto' | 'human-revision';
  quality: { saturated: boolean; tailing: boolean; overlap: boolean };
  centerRangePx?: [number, number];
  hypotheses?: { members: { xPx: number; yPx: number }[] }[];
}

export interface BandCentersContent {
  laneId: string;
  bands: BandCenter[];
  basis: 'image-px-top-left';
}

export type MaterialKind =
  | 'gel-image'
  | 'capture-meta'
  | 'ladder'
  | 'lane-boundaries'
  | 'band-centers';

export interface Material<T = unknown> {
  id: string;
  projectId: string;
  kind: MaterialKind;
  seq: number;
  content: T;
  digest: string;
  createdAt: string;
}

export interface Decision {
  id: string;
  projectId: string;
  seq: number;
  type:
    | 'accept-value'
    | 'reject-value'
    | 'accept-candidate'
    | 'reject-candidate'
    | 'revise-params'
    | 'revise-band-center'
    | 'resolve-conflict'
    | 'note';
  targetId: string;
  payload: Record<string, unknown>;
  supersedes: string | null;
  branch: string;
  createdAt: string;
}

export interface Derivation {
  id: string;
  projectId: string;
  kind: 'lane-ruler' | 'mw-inference' | 'normalization';
  inputDigest: string;
  paramVersion: string;
  parents: string[];
  status: 'valid' | 'invalidated';
  result: unknown;
  diagnostics: Diagnostic[];
  createdAt: string;
}

export interface EventRecord {
  id: string;
  projectId: string;
  seq: number;
  type: string;
  payload: Record<string, unknown>;
  createdAt: string;
}
