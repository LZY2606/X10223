import type { ParamSet } from '../shared/types';

/**
 * 参数版本：任何计算都携带版本号；修订生成新版本，历史结论绑定旧版本。
 */
export const PARAM_VERSIONS = {
  laneDetection: 'gel.laneDetection/1.0',
  bandDetection: 'gel.bandDetection/1.0',
  calibration: 'gel.calibration/1.0',
  saturation: 'gel.saturation/1.0',
} as const;

export const DEFAULT_PARAMS: Record<string, ParamSet> = {
  [PARAM_VERSIONS.laneDetection]: {
    version: PARAM_VERSIONS.laneDetection,
    values: { stripProminence: 0.15, minStripWidthPx: 14, maxGapMergePx: 6 },
  },
  [PARAM_VERSIONS.bandDetection]: {
    version: PARAM_VERSIONS.bandDetection,
    values: { minProminence: 18, minPeakDistancePx: 8, overlapValleyRatio: 0.55, broadWidthPx: 13, tailingShiftRatio: 0.35 },
  },
  [PARAM_VERSIONS.calibration]: {
    version: PARAM_VERSIONS.calibration,
    values: { missingSkipPenalty: 200, extrapolation: 'forbidden-flag-only', interp: 'log-linear-local' },
  },
  [PARAM_VERSIONS.saturation]: {
    version: PARAM_VERSIONS.saturation,
    values: { saturationFraction: 0.98 },
  },
};

/** bandDetection/2.0：更宽的峰间距阈值（参数修订案例使用） */
export function revisedBandParams(parent: ParamSet): ParamSet {
  return {
    version: 'gel.bandDetection/2.0',
    values: { ...parent.values, minPeakDistancePx: 11, overlapValleyRatio: 0.62 },
    parentVersion: parent.version,
  };
}
