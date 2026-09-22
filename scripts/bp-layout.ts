// 基线胶布局：8 道（1 ladder + 7 sample），井在顶部
export const GEL_W = 320;
export const GEL_H = 420;
export const WELL_Y = 24;
export const LANE_LENGTH = 372;
export const HALF_W = 13;
export const LANE_X = [36, 72, 108, 144, 180, 216, 252, 288];
export const LANE_IDS = ['lane-L', 'lane-1', 'lane-2', 'lane-3', 'lane-4', 'lane-5', 'lane-6', 'lane-7'];

// ladder 标称（bp），自井口向下、由大到小
export const LADDER_BP = [1500, 1000, 750, 500, 300, 200, 100, 50];
// 基线中 ladder 各带的弧长位置（单调）
export const LADDER_S = [54, 92, 122, 158, 200, 240, 300, 348];

// sample 道基线人工条带（lane idx -> s 列表），其中 lane-3 预置一对重叠带，lane-5 预置饱和
export const SAMPLE_BANDS: Record<number, { s: number; saturated?: boolean; overlap?: boolean; tailed?: boolean }[]> = {
  1: [{ s: 96 }, { s: 160 }, { s: 246 }],
  2: [{ s: 124 }, { s: 202 }],
  3: [{ s: 150, overlap: true }, { s: 156, overlap: true }, { s: 280 }],
  4: [{ s: 88 }, { s: 170 }, { s: 318 }],
  5: [{ s: 130, saturated: true }, { s: 244 }],
  6: [{ s: 104 }, { s: 214 }, { s: 330, tailed: true }],
  7: [{ s: 116 }, { s: 262 }],
};
