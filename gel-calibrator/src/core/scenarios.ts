// The bundled offline domain case pack: one synthetic gel + material layout per
// boundary condition. This is real electrophoresis imagery (lanes/ladder/bands),
// not a generic table.
import { DrawnBand, RenderSpec, renderGel, pngToBase64, laneCenterline, laneXAtY } from './render-gel.js';

export const W = 300, H = 360, LANE_HW = 14;
export const LANE_X = [55, 150, 245];
// Ladder nominal sizes (bp), top -> bottom.
export const NOMINALS = [1500, 1000, 750, 500, 250, 100];
export const LADDER_YS = [55, 95, 135, 180, 230, 285];

const ladderBands = (laneIndex: number, saturatedIdx = -1): DrawnBand[] =>
  LADDER_YS.map((y, i) => ({
    laneIndex, x: 0, y, intensity: 0.9, ry: 7,
    saturated: i === saturatedIdx,
  }));

const sampleBands = (laneIndex: number, defs: Array<Partial<DrawnBand> & { y: number }>): DrawnBand[] =>
  defs.map((d, i) => ({
    laneIndex, x: 0, y: d.y!, intensity: d.intensity ?? 0.85, ry: d.ry ?? 7,
    saturated: d.saturated, smear: d.smear, overlapWith: d.overlapWith,
  }));

const straight = [0, 0, 0];
const smile = [0, 26, 0];

export interface ScenarioDef {
  id: string;
  title: string;
  expectation: string;
  orientation: 0 | 90 | 180 | 270;
  exposure: { value: number; unit: 'ms'; raw: string };
  spec: RenderSpec;
  ladderLane: number;
  sampleLane: number;
  missingIndexes: number[];
  smileAmplitudes: number[];
}

function make(id: string, title: string, expectation: string, opts: Partial<ScenarioDef> & {
  bands?: DrawnBand[]; smile?: number[]; orientation?: 0 | 90 | 180 | 270;
  ladder?: DrawnBand[]; samples?: DrawnBand[];
}): ScenarioDef {
  const bands = [...(opts.ladder ?? ladderBands(0)), ...(opts.samples ?? sampleBands(1, [{ y: 150 }]))];
  const smileAmplitudes = opts.smile ?? straight;
  return {
    id, title, expectation,
    orientation: opts.orientation ?? 0,
    exposure: { value: 120, unit: 'ms', raw: '120 ms' },
    spec: { width: W, height: H, laneCenters: LANE_X, laneHalfWidth: LANE_HW, bands, laneSmileAmplitude: smileAmplitudes },
    ladderLane: 0, sampleLane: 1, missingIndexes: [], smileAmplitudes,
    ...opts,
  };
}

export const SCENARIOS: ScenarioDef[] = [
  make('baseline', '基线：六带 ladder + 直泳道',
    '所有样本带得到唯一分子量，校准状态 ok',
    { samples: sampleBands(1, [{ y: 110 }, { y: 200 }, { y: 255 }]) }),

  make('rotated', '旋转图像：原图按 90° 拍摄',
    '拍摄方向是直接来源；旋转后坐标转回 canonical，分子量与基线一致',
    { orientation: 90, samples: sampleBands(1, [{ y: 110 }, { y: 200 }]) }),

  make('smile', '“微笑”弯曲泳道',
    '同一像素高度在弯曲/直泳道映射到不同分子量；局部标尺带有效区域',
    {
      smile,
      samples: [...sampleBands(1, [{ y: 150 }]), ...sampleBands(2, [{ y: 150 }])],
    }),

  make('missing', 'ladder 缺带（第 3 标称 750bp 缺失）',
    '缺带被桥接并降级；跨缺口推断标区间，位置诊断保留',
    { missingIndexes: [2], samples: sampleBands(1, [{ y: 150 }]) }),

  make('saturated', '饱和区（ladder 一带削顶 + 一样本带饱和）',
    '饱和 ladder 点剔除；饱和样本只给区间，不给点值',
    { missingIndexes: [3], ladder: ladderBands(0), samples: sampleBands(1, [{ y: 150, saturated: true }]) }),

  make('overlap', '两条样本带重叠',
    '无法唯一去卷积时保留全部合法候选（candidates），不得只给一个值',
    {
      samples: [
        { laneIndex: 1, x: 0, y: 150, intensity: 0.85, ry: 7, overlapWith: 1 },
        { laneIndex: 1, x: 0, y: 155, intensity: 0.85, ry: 7, overlapWith: 0 },
      ],
    }),

  make('smear', '拖尾样本带',
    '拖尾只标区间，质心不确定必须显式',
    { samples: sampleBands(1, [{ y: 200, smear: true, ry: 8 }]) }),

  make('nonmonotonic', '非单调标尺（两 ladder 中心颠倒）',
    '校准 failed / SEMANTIC_UNSOLVABLE；不能强行拟合',
    { ladder: [...ladderBands(0)].map((b, i) => i === 2 ? { ...b, y: 200 } : i === 3 ? { ...b, y: 135 } : b),
      samples: sampleBands(1, [{ y: 150 }]) }),
];

export function renderScenario(def: ScenarioDef) {
  const png = renderGel(def.spec);
  return { base64: pngToBase64(png), width: png.width, height: png.height };
}

export { laneCenterline, laneXAtY };
