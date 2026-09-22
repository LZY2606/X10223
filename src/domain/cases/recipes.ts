import type { GelRecipe } from '../../server/gel-render.js';

// 迁移方向自上而下；ladder 标称值按目录顺序（大->小），t 递增。
const LADDER_T = [0.08, 0.22, 0.38, 0.53, 0.68, 0.83, 0.95];
const LADDER_NOMINALS = [
  { id: 'n10k', raw: '10000 bp' },
  { id: 'n5k', raw: '5000 bp' },
  { id: 'n3k', raw: '3000 bp' },
  { id: 'n2k', raw: '2000 bp' },
  { id: 'n1k', raw: '1000 bp' },
  { id: 'n500', raw: '500 bp' },
  { id: 'n200', raw: '200 bp' },
];

function ladderBands(prefix: string, opts: { missing?: number[]; swapPair?: [number, number] } = {}) {
  return LADDER_T.map((t, i) => {
    let tt = t;
    if (opts.swapPair && opts.swapPair.includes(i)) {
      const [a, b] = opts.swapPair;
      tt = i === a ? LADDER_T[b] : LADDER_T[a];
    }
    return {
      id: `${prefix}-lb${i + 1}`,
      t: tt,
      intensity: 0.8,
      missing: opts.missing?.includes(i),
      ladderNominalId: LADDER_NOMINALS[i].id,
    };
  });
}

function straightLanes(): GelRecipe['lanes'] {
  return [
    {
      id: 'lane-ladder',
      label: 'L',
      curve: 'straight',
      bands: ladderBands('base'),
    },
    {
      id: 'lane-a',
      label: 'A',
      curve: 'straight',
      bands: [
        { id: 'base-a1', t: 0.3, intensity: 0.7 },
        { id: 'base-a2', t: 0.62, intensity: 0.72 },
        { id: 'base-a3', t: 0.88, intensity: 0.68 },
      ],
    },
    {
      id: 'lane-b',
      label: 'B',
      curve: 'straight',
      bands: [
        { id: 'base-b1', t: 0.45, intensity: 0.74 },
        { id: 'base-b2', t: 0.75, intensity: 0.7 },
      ],
    },
    {
      id: 'lane-c',
      label: 'C',
      curve: 'straight',
      bands: [{ id: 'base-c1', t: 0.98, intensity: 0.66 }],
    },
  ];
}

export const BASE_RECIPE: GelRecipe = {
  slug: 'case01-baseline',
  widthPx: 320,
  heightPx: 420,
  orientationDeg: 0,
  exposureTimeSec: 0.5,
  gain: 1.0,
  lanes: straightLanes(),
  ladderLaneId: 'lane-ladder',
  ladderUnit: 'bp',
  ladderCatalog: 'DS-10k demo ladder (10000/5000/3000/2000/1000/500/200 bp)',
  ladderNominals: LADDER_NOMINALS,
};

export const SCENARIO_RECIPES: GelRecipe[] = [
  // 1. 旋转图像：只改拍摄方向直接来源，泳道/条带几何随图像旋转
  {
    ...BASE_RECIPE,
    slug: 'case02-rotated',
    orientationDeg: 90,
    lanes: straightLanes().map((l) => ({ ...l, bands: l.bands.map((b) => ({ ...b, id: b.id.replace('base', 'rot') })) })),
  },
  // 2. 弯曲泳道（微笑）：同一图像高度不等于同一分子量
  {
    ...BASE_RECIPE,
    slug: 'case03-smile',
    lanes: [
      { ...straightLanes()[0], id: 'lane-ladder', curve: 'smile', curveAmpPx: 26, bands: ladderBands('smile').map((b) => ({ ...b, id: b.id.replace('smile-lb', 'smile-lb') })) },
      { ...straightLanes()[1], id: 'lane-a', curve: 'smile', curveAmpPx: 26, bands: straightLanes()[1].bands.map((b) => ({ ...b, id: b.id.replace('base', 'smile') })) },
      { ...straightLanes()[2], id: 'lane-b', curve: 'straight', bands: straightLanes()[2].bands.map((b) => ({ ...b, id: b.id.replace('base', 'smile') })) },
      { ...straightLanes()[3], id: 'lane-c', curve: 'frown', curveAmpPx: 20, bands: straightLanes()[3].bands.map((b) => ({ ...b, id: b.id.replace('base', 'smile') })) },
    ],
  },
  // 3. ladder 缺带：3000bp 标称缺带，桥接段只能给区间
  {
    ...BASE_RECIPE,
    slug: 'case04-missing-ladder',
    lanes: [
      { id: 'lane-ladder', label: 'L', curve: 'straight', bands: ladderBands('miss', { missing: [2] }).map((b) => ({ ...b, id: b.id.replace('miss-lb', 'miss-lb') })) },
      { ...straightLanes()[1], bands: straightLanes()[1].bands.map((b) => ({ ...b, id: b.id.replace('base', 'miss') })) },
      { ...straightLanes()[2], bands: straightLanes()[2].bands.map((b) => ({ ...b, id: b.id.replace('base', 'miss') })) },
      { ...straightLanes()[3], bands: straightLanes()[3].bands.map((b) => ({ ...b, id: b.id.replace('base', 'miss') })) },
    ],
    ladderNominals: LADDER_NOMINALS.map((n, i) => (i === 2 ? { ...n, missing: true } : n)),
  },
  // 4. 饱和区：样品条带峰顶削平，只能候选/区间
  {
    ...BASE_RECIPE,
    slug: 'case05-saturated',
    lanes: [
      { ...straightLanes()[0], bands: ladderBands('sat').map((b) => ({ ...b, id: b.id.replace('sat-lb', 'sat-lb') })) },
      {
        ...straightLanes()[1],
        bands: [
          { id: 'sat-a1', t: 0.3, saturated: true, intensity: 1 },
          { id: 'sat-a2', t: 0.62, intensity: 0.72 },
          { id: 'sat-a3', t: 0.88, saturated: true, intensity: 1 },
        ],
      },
      { ...straightLanes()[2], bands: straightLanes()[2].bands.map((b) => ({ ...b, id: b.id.replace('base', 'sat') })) },
      { ...straightLanes()[3], bands: straightLanes()[3].bands.map((b) => ({ ...b, id: b.id.replace('base', 'sat') })) },
    ],
  },
  // 5. 两条带重叠 + 拖尾：保留全部合法候选
  {
    ...BASE_RECIPE,
    slug: 'case06-overlap',
    lanes: [
      { ...straightLanes()[0], bands: ladderBands('ovl').map((b) => ({ ...b, id: b.id.replace('ovl-lb', 'ovl-lb') })) },
      {
        ...straightLanes()[1],
        bands: [
          { id: 'ovl-a1', t: 0.49, intensity: 0.72, sigmaY: 7 },
          { id: 'ovl-a2', t: 0.555, intensity: 0.7, sigmaY: 7, overlapWith: ['ovl-a1'] },
        ],
      },
      {
        ...straightLanes()[2],
        bands: [
          { id: 'ovl-b1', t: 0.6, smear: true, sigmaY: 8, intensity: 0.7 },
          { id: 'ovl-b2', t: 0.82, intensity: 0.68 },
        ],
      },
      { ...straightLanes()[3], bands: straightLanes()[3].bands.map((b) => ({ ...b, id: b.id.replace('base', 'ovl') })) },
    ],
  },
  // 6. 非单调标尺：交换 2000/1000 的物理位置，对应插值段局部失效
  {
    ...BASE_RECIPE,
    slug: 'case07-nonmonotonic',
    lanes: [
      {
        id: 'lane-ladder',
        label: 'L',
        curve: 'straight',
        bands: ladderBands('nm', { swapPair: [3, 4] }).map((b) => ({ ...b, id: b.id.replace('nm-lb', 'nm-lb') })),
      },
      {
        ...straightLanes()[1],
        bands: [
          { id: 'nm-a1', t: 0.3, intensity: 0.7 },
          { id: 'nm-a2', t: 0.53, intensity: 0.72 },
          { id: 'nm-a3', t: 0.88, intensity: 0.68 },
        ],
      },
      { ...straightLanes()[2], bands: straightLanes()[2].bands.map((b) => ({ ...b, id: b.id.replace('base', 'nm') })) },
      { ...straightLanes()[3], bands: straightLanes()[3].bands.map((b) => ({ ...b, id: b.id.replace('base', 'nm') })) },
    ],
  },
];

export const ALL_RECIPES = [BASE_RECIPE, ...SCENARIO_RECIPES];

/** 修订案例的剧本（参数修订 + 只影响局部依赖的源数据改动 + 互相冲突的人工决定） */
export const REVISION_SCRIPT = {
  baseSlug: 'case01-baseline',
  slug: 'case08-revision',
  steps: [
    { kind: 'PARAMETERS_REVISED', reason: '审阅者收紧饱和阈值到 0.85 并要求缺带桥接给区间', patch: { saturationThreshold: 0.85 } },
    {
      kind: 'SOURCE_PATCHED',
      description: '只移动 lane-a 的 base-a2 条带中心（局部源数据改动，仅该泳道推断受影响）',
      objectKind: 'band',
      objectBandLocalId: 'base-a2',
      field: 'center',
      deltaRawPx: { x: 0, y: -26 },
    },
    { kind: 'MW_DECISION', bandLocalId: 'base-a1', decision: 'accepted', reason: '第一轮：接受自动候选' },
    { kind: 'MW_DECISION', bandLocalId: 'base-a2', decision: 'rejected', reason: '第二轮：人工否定同泳道另一带（互相冲突的决定并存）' },
  ] as const,
};
