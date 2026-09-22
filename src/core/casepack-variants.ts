import {
  baselineBands,
  GEL_HEIGHT,
  GEL_WIDTH,
  LANE_X,
  LADDER_NOMINAL,
  type GelBandSpec,
  type GelVariant
} from './gelgen';

export interface BranchDef {
  name: string;
  purpose: string;
  variant: GelVariant;
  nonmonotonic?: boolean;
  startOrientation?: number; // 初始拍摄方向（错误方向用于旋转分支）
}

function bands(): GelBandSpec[] {
  return baselineBands();
}

export function buildBranchDefs(): BranchDef[] {
  return [
    {
      name: 'baseline',
      purpose: '基线：原图/方向/曝光/ladder 标称值/lane 边界/条带中心全部像素级留源',
      variant: { seed: 20260923, smile: false, bands: bands(), frameId: 'frame://baseline/raw' },
      startOrientation: 1
    },
    {
      name: 'rotated',
      purpose: '旋转图像：错误拍摄方向必须先产生带位置诊断，纠正后才能检测',
      variant: { seed: 20260924, smile: false, bands: bands(), frameId: 'frame://rotated/raw' },
      startOrientation: 1
    },
    {
      name: 'smile',
      purpose: '微笑弯曲：同高度不等于同分子量，局部标尺必须带弧长有效区域',
      variant: { seed: 20260925, smile: true, bands: bands(), frameId: 'frame://smile/raw' },
      startOrientation: 1
    },
    {
      name: 'ladder-missing',
      purpose: 'ladder 缺带：保留全部合法对齐候选，缺环外不扩散影响',
      variant: {
        seed: 20260926,
        smile: false,
        bands: bands().map((b) => (b.laneIndex === 0 && b.massBp === 1500 ? { ...b, missing: true } : b)),
        frameId: 'frame://ladder-missing/raw'
      },
      startOrientation: 1
    },
    {
      name: 'saturated',
      purpose: '饱和区：峰值截断，分子量只能标为区间',
      variant: { seed: 20260927, smile: false, bands: bands(), frameId: 'frame://saturated/raw' },
      startOrientation: 1
    },
    {
      name: 'overlap',
      purpose: '两条带重叠：无法唯一归属时保留全部合法候选',
      variant: { seed: 20260928, smile: false, bands: bands(), frameId: 'frame://overlap/raw' },
      startOrientation: 1
    },
    {
      name: 'nonmonotonic',
      purpose: '非单调标尺：标称值乱序时禁止任何分子量内插',
      variant: { seed: 20260929, smile: false, bands: bands(), frameId: 'frame://nonmonotonic/raw' },
      nonmonotonic: true,
      startOrientation: 1
    },
    {
      name: 'local-invalidation',
      purpose: '修订后局部失效：只改动一条 lane 边界，影响必须被限制在该 lane 的条带',
      variant: { seed: 20260930, smile: false, bands: bands(), frameId: 'frame://local-invalidation/raw' },
      startOrientation: 1
    }
  ];
}

export const GEL_DIMENSIONS = { width: GEL_WIDTH, height: GEL_HEIGHT };
export const LADDER_LANE_INDEX = 0;
export const LANE_CENTERS = LANE_X;
export const LADDER_BASE_NOMINAL = LADDER_NOMINAL;
