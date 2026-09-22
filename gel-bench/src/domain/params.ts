/**
 * 参数版本。所有计算结果记录 paramVersion；参数修订生成新事件与新派生结果，
 * 不覆盖历史。
 */
export interface CalcParams {
  version: string;
  saturationClip: number; // 强度 >= 该比例(相对 maxEncoded) 视为饱和，ratio
  minBandProminence: number; // ratio
  overlapCenterDistancePx: number; // 中心距小于该值判为重叠
  tailingAsymmetry: number; // 轮廓不对称比阈值
  maxAlignmentCandidates: number; // ladder 缺带时保留的全部合法对齐候选上限
  maxResidualRatio: number; // 合法对齐的最大拟合残差(相对迁移量程)
  validMargin: number; // 局部标尺两端保留余量，ratio
  maxBudget: { materials: number; pixels: number; alignments: number };
}

export const PARAM_V1: CalcParams = {
  version: 'calcrules/v1.0.0',
  saturationClip: 0.98,
  minBandProminence: 0.12,
  overlapCenterDistancePx: 10,
  tailingAsymmetry: 1.8,
  maxAlignmentCandidates: 24,
  maxResidualRatio: 0.05,
  validMargin: 0.0,
  maxBudget: { materials: 5000, pixels: 20_000_000, alignments: 100_000 },
};

/** v2：修订饱和阈值与标尺余量 —— 只重新推导依赖它们的结果 */
export const PARAM_V2: CalcParams = {
  ...PARAM_V1,
  version: 'calcrules/v2.0.0',
  saturationClip: 0.9,
  validMargin: 0.02,
  minBandProminence: 0.1,
};

export function getParamVersion(version: string): CalcParams {
  if (version === PARAM_V1.version) return PARAM_V1;
  if (version === PARAM_V2.version) return PARAM_V2;
  throw new Error(`UNKNOWN_PARAM_VERSION:${version}`);
}
