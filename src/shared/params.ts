import type { ParameterSet } from './types.ts';

export const PARAMETER_VERSIONS: Record<string, ParameterSet> = {
  'params-2026-01': {
    version: 'params-2026-01',
    detection: {
      bandThresholdRatio: 0.32,
      minBandWidthPx: 2,
      maxBandWidthPx: 26,
      overlapSeparationPx: 7,
      saturationLevel: 250,
      tailAsymmetryRatio: 1.8
    },
    calibration: { model: 'piecewise-linear-log', maxGapOrder: 0 }
  },
  'params-2026-02': {
    version: 'params-2026-02',
    detection: {
      bandThresholdRatio: 0.28,
      minBandWidthPx: 2,
      maxBandWidthPx: 30,
      overlapSeparationPx: 6,
      saturationLevel: 248,
      tailAsymmetryRatio: 1.6
    },
    calibration: { model: 'piecewise-linear-log', maxGapOrder: 0 }
  }
};

export const DEFAULT_PARAMETER_VERSION = 'params-2026-01';

export function resolveParameterSet(version: string, overrides?: Record<string, number>): ParameterSet {
  const base = PARAMETER_VERSIONS[version];
  if (!base) throw new Error(`unknown parameter version: ${version}`);
  if (!overrides || Object.keys(overrides).length === 0) return base;
  const det = { ...base.detection, ...pick(overrides, base.detection) };
  return { ...base, detection: det };
}

function pick(overrides: Record<string, number>, allowed: Record<string, unknown>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const key of Object.keys(overrides)) {
    if (key in allowed) out[key] = overrides[key]!;
  }
  return out;
}
