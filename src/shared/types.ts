/** Shared domain types. All domain quantities carry a unit or coordinate basis. */

export type Orientation = 0 | 90 | 180 | 270;

/** Pixel coordinate basis: origin at image top-left, y grows downward = migration direction. */
export const PIXEL_BASIS = 'image-top-left-y-down' as const;
export const MW_UNIT = 'bp' as const;
export const EXPOSURE_UNIT = 'ms' as const;

export interface PixelPoint {
  x: number; // px, basis image-top-left-y-down
  y: number; // px
}

export interface GelImageMeta {
  width: number; // px
  height: number; // px
  exposureMs: number; // ms
  orientation: Orientation; // capture direction, degrees clockwise
  pixelBasis: typeof PIXEL_BASIS;
}

export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array; // row-major grayscale 0..255
}

export type SourceKind = 'auto' | 'manual';

export interface LaneBoundary {
  laneId: string;
  index: number;
  left: number; // px
  right: number; // px
  /** Lane center curve, sampled pixel points top -> bottom. Captures bent lanes. */
  centerCurve: PixelPoint[];
  source: SourceKind;
}

export type BandFlag = 'saturated' | 'overlap' | 'smear';

export interface BandCenter {
  bandId: string;
  laneId: string;
  y: number; // px, peak or plateau center
  yLo: number; // px, half-max / plateau extent
  yHi: number; // px
  peakIntensity: number; // 0..255
  flags: BandFlag[];
  source: SourceKind;
}

export interface LadderNominal {
  nominalId: string;
  mwBp: number; // bp
}

export interface Diagnostic {
  code: string;
  message: string;
  /** Position of the problem: pixel point, or lane + optional y. Never silently dropped. */
  position?: { x?: number; y?: number; laneId?: string };
}

export interface RulerSegment {
  segmentId: string;
  yTop: number; // px (smaller y)
  yBottom: number; // px (larger y)
  mwTopBp: number; // bp at yTop
  mwBottomBp: number; // bp at yBottom
  ladderBandTop: string; // bandId
  ladderBandBottom: string; // bandId
  valid: boolean;
  invalidReason?: string;
  spansGap?: boolean;
}

export interface LocalRuler {
  laneId: string;
  /** Vertical offset (px) of this lane relative to the ladder lane, from lane-curve alignment. */
  offsetPx: number;
  /** Validity region of the local ruler in this lane's pixel coordinates. */
  validYLo: number;
  validYHi: number;
  segments: RulerSegment[];
}

export type MwEstimate =
  | { kind: 'value'; mwBp: number; segmentId: string }
  | { kind: 'interval'; loBp: number; hiBp: number; reason: string; segmentId: string }
  | { kind: 'candidates'; options: { mwBp: number; segmentId: string }[]; reason: string }
  | { kind: 'invalid'; diagnostic: Diagnostic };

export interface BandResult {
  resultId: string;
  bandId: string;
  laneId: string;
  estimate: MwEstimate;
  status: 'value' | 'interval' | 'candidates' | 'invalid';
  /** Validity region (px, this lane) of the local ruler segment used, when any. */
  validY?: { lo: number; hi: number };
  invalidReason?: string;
}

export interface AnalysisParams {
  paramVersion: string;
  laneThreshold: number;
  minLaneWidthPx: number;
  bandThreshold: number;
  overlapValleyRatio: number;
  saturationLevel: number;
  smearTailRatio: number;
  maxLanes: number; // resource budget
  maxBandsPerLane: number; // resource budget
}

export const PARAMS_V1: AnalysisParams = {
  paramVersion: 'params-v1',
  laneThreshold: 6,
  minLaneWidthPx: 8,
  bandThreshold: 28,
  overlapValleyRatio: 0.55,
  saturationLevel: 255,
  smearTailRatio: 2.5,
  maxLanes: 24,
  maxBandsPerLane: 64,
};
