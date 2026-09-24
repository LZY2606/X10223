/** Shared domain types. Layers: immutable materials vs. mutable decisions (events). */

export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export type Unit = 'kDa' | 'bp' | 'ms' | 'px' | 'deg' | '1';

export interface Quantity {
  value: number;
  unit: Unit;
}

/** Pixel-level provenance basis: every coordinate states its frame. */
export interface PixelBasis {
  origin: 'top-left';
  axis: 'x-right-y-down';
  /** Physical rotation of the capture relative to the canonical gel orientation. */
  orientationDeg: 0 | 90 | 180 | 270;
}

export interface PixelRegion {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Provenance {
  /** 'auto' = produced by a detection computation, 'manual' = human revision, 'import' = raw import. */
  source: 'auto' | 'manual' | 'import';
  imageId: string;
  region?: PixelRegion;
  basis: PixelBasis;
  computationId?: string;
}

export interface Diagnostic {
  code: string;
  message: string;
  location: {
    materialId?: string;
    jsonPath?: string;
    region?: PixelRegion;
    laneId?: string;
    bandId?: string;
  };
}

export type MaterialKind =
  | 'gel_image'
  | 'capture_meta'
  | 'ladder_standard'
  | 'lane_boundaries'
  | 'band_centers'
  | 'param_set';

export interface Material {
  id: string;
  kind: MaterialKind;
  version: number;
  /** Previous version of the same logical material, null for the first. */
  parentId: string | null;
  branch: string;
  createdByEvent: string;
  createdSeq: number;
  /** Raw representation as imported; normalization happens only in derived layers. */
  payload: Json;
}

export type EventKind =
  | 'import_baseline'
  | 'import_scenario'
  | 'param_revision'
  | 'source_revision'
  | 'decision'
  | 'judgment'
  | 'note';

export interface Event {
  id: string;
  seq: number;
  branch: string;
  kind: EventKind;
  payload: Json;
  parents: string[];
}

/**
 * Three resource/format/semantic failure kinds must stay distinguishable,
 * plus incomplete input which is reported with locations instead of fake defaults.
 */
export type ComputationStatus =
  | 'ok'
  | 'budget_exhausted'
  | 'corrupt_format'
  | 'semantic_unsolvable'
  | 'incomplete_input';

export type ComputationKind =
  | 'detect_lanes'
  | 'detect_bands'
  | 'build_scale'
  | 'infer_mw';

export interface Computation {
  id: string;
  kind: ComputationKind;
  branch: string;
  inputDigest: string;
  /** Id of the param_set material version used. */
  paramVersion: string;
  parents: string[];
  status: ComputationStatus;
  result: Json | null;
  diagnostics: Diagnostic[];
  createdSeq: number;
  supersededAtSeq: number | null;
  invalidationReason: string | null;
}

export interface Branch {
  id: string;
  name: string;
  forkedFrom: string | null;
  forkSeq: number | null;
}

export interface Bundle {
  format: 'gel-workbench-bundle';
  formatVersion: 1;
  exportedSeq: number;
  branches: Branch[];
  materials: Material[];
  events: Event[];
  computations: Computation[];
}
