import type { CalibrationParams } from './types';

export const PARAMS_V1: CalibrationParams = {
  version: 1,
  method: 'global-loglinear',
  saturationThreshold: 254,
  minPeakProminence: 18,
  overlapDistancePx: 26,
  monotonic: true,
  note: 'v1：全局 log10(bp)-迁移弧长直线拟合'
};

export const PARAMS_V2: CalibrationParams = {
  version: 2,
  method: 'piecewise-linear',
  saturationThreshold: 240,
  minPeakProminence: 16,
  overlapDistancePx: 24,
  monotonic: true,
  note: 'v2：相邻 ladder 点分段内插，饱和阈值收紧'
};

export const PARAMS_BY_VERSION: Record<1 | 2, CalibrationParams> = { 1: PARAMS_V1, 2: PARAMS_V2 };
