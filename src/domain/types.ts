import type { Diagnostic, PixelPoint } from './units.ts';

/** Outcomes are a closed, machine-readable taxonomy. Resource budget
 *  exhaustion, corrupt formats and semantic unsolvability are three
 *  distinct results — never collapsed into a generic "error". */
export type Outcome =
  | { kind: 'ok' }
  | { kind: 'budget_exhausted'; diagnostics: Diagnostic[] }
  | { kind: 'format_corrupt'; diagnostics: Diagnostic[] }
  | { kind: 'semantically_unsolvable'; diagnostics: Diagnostic[] };

export type MaterialKind =
  | 'gel_image'
  | 'capture_orientation'
  | 'exposure'
  | 'ladder_nominal'
  | 'lane_boundary'
  | 'band_centers';

/** Immutable material: the raw representation is preserved verbatim,
 *  identity is content-addressed, seq fixes import order. */
export interface Material {
  id: string;
  kind: MaterialKind;
  label: string;
  raw: unknown;
  digest: string;
  seq: number;
}

export interface ParamSet {
  version: string;
  interpolation: 'log-linear';
  saturation_threshold: number;
  overlap_min_sep_px: number;
  valid_region_margin_px: number;
  solver_budget: number;
  smile_model: 'quadratic';
}

export const PARAMS_V1: ParamSet = {
  version: 'params-v1',
  interpolation: 'log-linear',
  saturation_threshold: 250,
  overlap_min_sep_px: 8,
  valid_region_margin_px: 0,
  solver_budget: 1000,
  smile_model: 'quadratic',
};

export type EventType =
  | 'material.imported'
  | 'params.revised'
  | 'candidates.generated'
  | 'decision.accepted'
  | 'decision.rejected'
  | 'decision.adjusted'
  | 'source.amended'
  | 'conflict.recorded'
  | 'judgement.recorded'
  | 'scenario.replayed'
  | 'snapshot.exported'
  | 'snapshot.imported';

export interface AppEvent {
  seq: number;
  id: string;
  branch: string;
  type: EventType;
  payload: unknown;
  parents: string[];
  created_at: string;
}

export type ResultStatus = 'ok' | 'candidate' | 'interval' | 'invalid' | 'superseded';

export type ResultKind = 'lane_curve' | 'ruler' | 'mw_estimate' | 'fit_residual';

/** Every derived result records its input digest, parameter version and
 *  parent dependencies so invalidation can be scoped to exactly the
 *  affected subgraph. */
export interface DerivedResult {
  id: string;
  kind: ResultKind;
  status: ResultStatus;
  input_digest: string;
  params_version: string;
  parents: string[];
  branch: string;
  seq: number;
  value: unknown;
}

export interface LaneBoundary {
  lane_index: number;
  role: 'ladder' | 'sample';
  x0: number;
  x1: number;
}

export interface BandCenter extends PixelPoint {
  band_id: string;
  lane_index: number;
  source: string;
}

export interface LadderNominal {
  sizes_bp: number[];
  unit: 'bp';
}

export interface CaptureOrientation {
  rotation_deg: 0 | 90 | 180 | 270;
  wells: 'top' | 'bottom' | 'left' | 'right';
}

export interface Exposure {
  time_ms: number;
  gain: number;
}

/** Machine-readable judgement codes required by the review archive. */
export const JUDGEMENT = {
  SMILE_LOCAL_RULER_REQUIRED: 'SMILE_LOCAL_RULER_REQUIRED',
  SATURATED_CANDIDATE_ONLY: 'SATURATED_CANDIDATE_ONLY',
  TAILING_CANDIDATE_ONLY: 'TAILING_CANDIDATE_ONLY',
  OVERLAP_INTERVAL_ONLY: 'OVERLAP_INTERVAL_ONLY',
  LADDER_GAP_INTERVAL: 'LADDER_GAP_INTERVAL',
  OUTSIDE_VALID_REGION: 'OUTSIDE_VALID_REGION',
} as const;

export type JudgementCode = (typeof JUDGEMENT)[keyof typeof JUDGEMENT];

export interface Judgement {
  code: JudgementCode;
  subject: string;
  detail: string;
  affected: string[];
}
