/** 8 种凝胶情形的渲染规格（像素级真值即自动候选材料的来源） */
const W = 460;
const H = 360;
const LANE_XS = [60, 140, 220, 300, 380];
const MARGIN = { marginTop: 24, marginBottom: 24 };

// 标准 ladder：质量随 y 增大单调下降
const LADDER_BANDS = [
  { y: 48, mass: 5000, nominalRow: 1, amp: 130 },
  { y: 82, mass: 3000, nominalRow: 2, amp: 122 },
  { y: 118, mass: 2000, nominalRow: 3, amp: 118 },
  { y: 152, mass: 1500, nominalRow: 4, amp: 112 },
  { y: 190, mass: 1000, nominalRow: 5, amp: 108 },
  { y: 226, mass: 750, nominalRow: 6, amp: 0, missing: true },
  { y: 262, mass: 500, nominalRow: 7, amp: 104 },
  { y: 300, mass: 250, nominalRow: 8, amp: 100 },
  { y: 330, mass: 100, nominalRow: 9, amp: 96 }
];

function sampleBands(overrides = {}) {
  return {
    S1: [{ y: 135, mass: 1700 }, { y: 245, mass: 620 }],
    S2: [{ y: 170, mass: 1180 }, { y: 285, mass: 320 }],
    S3: [{ y: 210, mass: 860 }],
    S4: [{ y: 120, mass: 2050 }, { y: 315, mass: 180 }],
    ...overrides
  };
}

function lanes(spec = {}) {
  const ladder = spec.ladder ?? LADDER_BANDS.filter((b) => !b.missing);
  const samples = spec.samples ?? sampleBands();
  return LANE_XS.map((x, i) => {
    const role = i === 0 ? 'ladder' : 'sample';
    const bands = i === 0 ? ladder : samples[['S1', 'S2', 'S3', 'S4'][i - 1]];
    return { x, role, width: 18, bend: spec.bendFor ? spec.bendFor(i) : 0, bands: bands ?? [] };
  });
}

export const GEL_SPECS = {
  main: {
    file: 'main.png',
    title: '基线胶：平直泳道、完整 ladder',
    width: W,
    height: H,
    background: 232,
    satGray: 16,
    seed: 11,
    ...MARGIN,
    lanes: lanes(),
    exposure: { exposureS: 0.8, gain: 1.4, saturationLevel: 255 },
    orientation: { rotation90: 0, flipH: false, flipV: false }
  },
  rotated: {
    file: 'rotated.png',
    title: '旋转图像：原图顺时针 90°，电泳方向需方向材料校正',
    width: H,
    height: W,
    background: 232,
    satGray: 16,
    seed: 12,
    marginTop: 24,
    marginBottom: 24,
    rotateRender90: 1,
    baseSpec: 'main',
    exposure: { exposureS: 0.8, gain: 1.4, saturationLevel: 255 },
    orientation: { rotation90: 1, flipH: false, flipV: false }
  },
  curved: {
    file: 'curved.png',
    title: '弯曲泳道（“微笑”）：同高度≠同分子量',
    width: W,
    height: H,
    background: 232,
    satGray: 16,
    seed: 13,
    ...MARGIN,
    lanes: lanes({ bendFor: (i) => (i === 0 ? 0 : 26) }),
    exposure: { exposureS: 0.8, gain: 1.4, saturationLevel: 255 },
    orientation: { rotation90: 0, flipH: false, flipV: false }
  },
  ladderMissing: {
    file: 'ladder-missing.png',
    title: 'ladder 缺带：750bp 锚点缺失形成局部无效区段',
    width: W,
    height: H,
    background: 232,
    satGray: 16,
    seed: 14,
    ...MARGIN,
    lanes: lanes({ ladder: LADDER_BANDS.filter((b) => !(b.mass === 750) && !b.missing) }),
    exposure: { exposureS: 0.8, gain: 1.4, saturationLevel: 255 },
    orientation: { rotation90: 0, flipH: false, flipV: false }
  },
  saturation: {
    file: 'saturation.png',
    title: '饱和区：S1 上带峰顶截断，只能给区间',
    width: W,
    height: H,
    background: 232,
    satGray: 16,
    seed: 15,
    ...MARGIN,
    lanes: lanes({
      samples: sampleBands({ S1: [{ y: 135, mass: 1700, saturated: true, amp: 250 }, { y: 245, mass: 620 }] })
    }),
    exposure: { exposureS: 2.4, gain: 2.8, saturationLevel: 255 },
    orientation: { rotation90: 0, flipH: false, flipV: false }
  },
  overlap: {
    file: 'overlap.png',
    title: '两条带重叠：S2 中部紧邻双峰，保留全部合法候选',
    width: W,
    height: H,
    background: 232,
    satGray: 16,
    seed: 16,
    ...MARGIN,
    lanes: lanes({
      samples: sampleBands({
        S2: [
          { y: 176, mass: 1080, overlapOffsets: [0, 7] },
          { y: 285, mass: 320 }
        ]
      })
    }),
    exposure: { exposureS: 0.8, gain: 1.4, saturationLevel: 255 },
    orientation: { rotation90: 0, flipH: false, flipV: false }
  },
  nonmonotonic: {
    file: 'nonmonotonic.png',
    title: '非单调标尺：标称表 1000bp 行被错改为 1200bp，区段判无效',
    width: W,
    height: H,
    background: 232,
    satGray: 16,
    seed: 17,
    ...MARGIN,
    lanes: lanes(),
    nominalOverrides: { 5: 1200 },
    exposure: { exposureS: 0.8, gain: 1.4, saturationLevel: 255 },
    orientation: { rotation90: 0, flipH: false, flipV: false }
  },
  localInvalid: {
    file: 'local-invalid.png',
    title: '修订后局部失效：人工删除 2000bp ladder 带，仅跨段推断失效',
    width: W,
    height: H,
    background: 232,
    satGray: 16,
    seed: 18,
    ...MARGIN,
    lanes: lanes({ ladder: LADDER_BANDS.filter((b) => !b.missing) }),
    dropNominalRows: [3],
    exposure: { exposureS: 0.8, gain: 1.4, saturationLevel: 255 },
    orientation: { rotation90: 0, flipH: false, flipV: false }
  }
};

export const LADDER_TABLE = [
  { row: 1, token: '5000bp', mass: 5000 },
  { row: 2, token: '3000bp', mass: 3000 },
  { row: 3, token: '2000bp', mass: 2000 },
  { row: 4, token: '1500bp', mass: 1500 },
  { row: 5, token: '1000bp', mass: 1000 },
  { row: 6, token: '750bp', mass: 750 },
  { row: 7, token: '500bp', mass: 500 },
  { row: 8, token: '250bp', mass: 250 },
  { row: 9, token: '100bp', mass: 100 },
  { row: 10, token: 'big?', mass: null }
];
