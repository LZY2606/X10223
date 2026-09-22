// 参数与规则版本：所有计算结果记录参数版本。
import type { ParamSet } from './types.js';

export const RULE_VERSIONS = {
  geometry: 'geometry-v1',
  detector: 'detector-v1',
  calibration: 'calibration-v1',
  mw: 'mw-v1',
  exposure: 'exposure-v1',
  pairing: 'pairing-v1',
} as const;

export const PARAMS_V1 = 'params-v1';
export const PARAMS_V2 = 'params-v2';

export function defaultParams(version: string = PARAMS_V1): ParamSet {
  if (version === PARAMS_V1) {
    return {
      version,
      detector: {
        bandProminenceZ: 3.0,
        minBandGapPx: 6,
        laneMinSeparationPx: 26,
        saturationAbsorbance: 0.97,
        tailingAsymmetryThreshold: 1.6,
        overlapHalfWidths: 1.5,
      },
      calibration: {
        model: 'piecewise_log_linear',
        wellReference: 'image_top',
      },
    };
  }
  if (version === PARAMS_V2) {
    // 修订：加样口参考改为沿 lane 曲线的局部弧长（微笑校正）
    return {
      version,
      detector: {
        bandProminenceZ: 3.0,
        minBandGapPx: 6,
        laneMinSeparationPx: 26,
        saturationAbsorbance: 0.97,
        tailingAsymmetryThreshold: 1.6,
        overlapHalfWidths: 1.5,
      },
      calibration: {
        model: 'piecewise_log_linear',
        wellReference: 'lane_arc_origin',
      },
    };
  }
  throw new Error(`unknown params version: ${version}`);
}

// 计算预算（资源耗尽必须区别于格式损坏与语义无解）
export const DEFAULT_BUDGET = {
  maxPairingPermutations: 5000,
  maxBands: 2000,
  maxPixelsPerChannel: 200_000_000,
};
export type Budget = typeof DEFAULT_BUDGET;
