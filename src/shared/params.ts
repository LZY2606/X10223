import { contentId } from './hash.js';

/** 参数版本：任何参数修订都会产生新 paramsVersion，下游全部重算。 */
export interface PipelineParams {
  version?: string;
  detection: {
    bandHalfWidthPx: number; // 沿泳道方向取平均窗口半宽
    lateralHalfWidthPx: number; // 横向半宽
    minPeakProminence: number; // 峰突出度阈值（0..255）
    plateauMinRunPx: number; // 判定饱和平台的最小连续长度
    saturationIntensity: number; // 饱和灰度阈值
    tailingAsymmetry: number; // 拖尾不对称比阈值
    overlapSeparationPx: number; // 小于该距离视为重叠
  };
  calibration: {
    logBase: 10;
    missingBandMaxShift: number; // 缺带时允许的最大错位
  };
  budget: {
    maxImagePixels: number;
    maxLanes: number;
    maxBandsPerLane: number;
    maxEvents: number;
  };
}

export const DEFAULT_PARAMS_V1: PipelineParams = {
  detection: {
    bandHalfWidthPx: 3,
    lateralHalfWidthPx: 6,
    minPeakProminence: 12,
    plateauMinRunPx: 5,
    saturationIntensity: 245,
    tailingAsymmetry: 1.8,
    overlapSeparationPx: 7,
  },
  calibration: { logBase: 10, missingBandMaxShift: 2 },
  budget: { maxImagePixels: 4_000_000, maxLanes: 48, maxBandsPerLane: 64, maxEvents: 5000 },
};

export function withVersion(p: PipelineParams): PipelineParams {
  const { version: _v, ...body } = p;
  return { ...p, version: contentId('params', body) };
}
