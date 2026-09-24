import type { GelParams } from "./types";

export const PARAMS_V1 = "rules/gel/v1";

export function defaultParams(overrides?: Partial<GelParams>): GelParams {
  const base: GelParams = {
    version: PARAMS_V1,
    bandDetection: {
      noisePercentile: 25,
      minProminence: 14,
      contourThresholdRatio: 0.5,
      minBandSpacingPx: 4
    },
    ladder: { gapPenalty: 2.5, monotonic: true },
    saturation: { plateauRatio: 0.35, tailSlope: 0.28 },
    overlap: { mergeSdRatio: 1.6 },
    ruler: { model: "piecewiseLinearLog", extrapolate: false, validMarginPx: 2 },
    budget: { maxOps: 50_000_000 }
  };
  if (!overrides) return base;
  return {
    ...base,
    ...overrides,
    bandDetection: { ...base.bandDetection, ...overrides.bandDetection },
    ladder: { ...base.ladder, ...overrides.ladder },
    saturation: { ...base.saturation, ...overrides.saturation },
    overlap: { ...base.overlap, ...overrides.overlap },
    ruler: { ...base.ruler, ...overrides.ruler },
    budget: { ...base.budget, ...overrides.budget }
  };
}
