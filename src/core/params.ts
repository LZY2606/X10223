import { contentId } from '../shared/identity'

export interface CalibParams {
  saturationGray: number // 灰度 >= 此值视为饱和
  saturatedFractionLimit: number // 带内饱和像素比例上限
  overlapFractionLimit: number // 超过该比例视为重叠
  smearTailRatio: number // 下半轮廓/上半轮廓比超过此值视为拖尾
  missingResidualSigma: number // 全局拟合残差离群阈值（sigma）
  minBandsPerLane: number
  monotonicToleranceLog: number // 标称值非单调容忍度（log10 单位）
  profileStepPx: number
  laneSearchHalfWidth: number
}

export const PARAMS_VERSIONS: Record<string, CalibParams> = {
  'calib-v1': {
    saturationGray: 245,
    saturatedFractionLimit: 0.02,
    overlapFractionLimit: 0.12,
    smearTailRatio: 1.8,
    missingResidualSigma: 2.5,
    minBandsPerLane: 2,
    monotonicToleranceLog: 0.0,
    profileStepPx: 4,
    laneSearchHalfWidth: 34
  },
  // 参数修订：放宽饱和像素比例、提高拖尾判定比。只影响以 v2 计算的工件。
  'calib-v2': {
    saturationGray: 240,
    saturatedFractionLimit: 0.05,
    overlapFractionLimit: 0.12,
    smearTailRatio: 2.2,
    missingResidualSigma: 2.5,
    minBandsPerLane: 2,
    monotonicToleranceLog: 0.0,
    profileStepPx: 4,
    laneSearchHalfWidth: 34
  }
}

export function paramsVersionId(version: string, params: CalibParams): string {
  return contentId('params', { version, params })
}

export function requireParams(version: string): CalibParams {
  const p = PARAMS_VERSIONS[version]
  if (!p) throw new Error(`未知参数版本: ${version}`)
  return p
}
