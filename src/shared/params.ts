/** 计算参数集中管理；每次修订产生新版本字符串，结果记录所用版本。 */
export interface CalibrationParams {
  version: string;
  saturationThreshold: number;
  saturatedFractionLimit: number; // 超过即判饱和
  overlapCenterDistanceMm: number; // 中心距小于条带宽度的倍数阈值
  minMonotonicOrder: number; // 相邻 ladder 点 MW 必须随弧长单调递减（取 log10 后递增）
  residualWarningMm: number;
  tailAsymmetryRatio: number;
}

export const PARAMS_V1: CalibrationParams = {
  version: 'calibration-1.0.0',
  saturationThreshold: 250,
  saturatedFractionLimit: 0.15,
  overlapCenterDistanceMm: 1.6,
  minMonotonicOrder: 1,
  residualWarningMm: 0.6,
  tailAsymmetryRatio: 1.8,
};

export const PARAMS_V2: CalibrationParams = {
  ...PARAMS_V1,
  version: 'calibration-1.1.0',
  saturatedFractionLimit: 0.1,
  overlapCenterDistanceMm: 1.35,
  residualWarningMm: 0.45,
};

/** 预算：检测/拟合允许处理的像素与候选数上限。耗尽是与格式损坏、语义无解不同的结果。 */
export interface ComputeBudget {
  pixelOps: number;
  candidates: number;
  usedPixelOps: number;
  usedCandidates: number;
}

export function createBudget(pixelOps = 40_000_000, candidates = 10_000): ComputeBudget {
  return { pixelOps, candidates, usedPixelOps: 0, usedCandidates: 0 };
}

export function chargePixels(budget: ComputeBudget, n: number) {
  budget.usedPixelOps += n;
  if (budget.usedPixelOps > budget.pixelOps) {
    // 延迟抛错由调用方统一处理（带位置）。
  }
}

export function assertBudget(budget: ComputeBudget, location?: { materialId?: string }) {
  if (budget.usedPixelOps > budget.pixelOps || budget.usedCandidates > budget.candidates) {
    return false;
  }
  return true;
}
