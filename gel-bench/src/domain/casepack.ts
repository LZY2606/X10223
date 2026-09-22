import { generateGel, rotateGrayPng, type SynthLane } from './gel-image';
import { contentId } from './ids';
import type { PixelPoint, UnitName } from './types';

/**
 * 离线案例包（领域材料，非通用表格）：
 *  - baseline：完整叙事（原图/方向/曝光/ladder 标称/lane 边界/条带中心像素来源，
 *    参数修订、局部源改动、冲突人工决定都在 replay 中产生）
 *  - counterexamples：七个反例情形，每个都从共同基线只改动一个直接来源
 */

export interface CaseLaneSpec {
  laneIndex: number;
  role: 'ladder' | 'sample';
  ladderNominal?: string;
}

export interface ScenarioAsset {
  key: string;
  title: string;
  singleSourceChanged: string;
  pngName: string;
  expectCodes: string[];
  /** 用于断言的领域真值 */
  expected: {
    ladderBp?: number[];
    sampleBands?: { laneIndex: number; expectBp?: number; expectInterval?: [number, number] }[];
  };
  ladderOverride?: { name: string; unit: UnitName; bands: { rank: number; mw: number; rawLabel: string }[] };
  orientationDeg?: number; // 顺时针修正到“孔在上”的角度
}

export interface BuiltCase {
  spec: {
    caseFormat: 'gel-bench-case/1';
    generatedBy: string;
    baseline: {
      name: string;
      pngName: string;
      width: number;
      height: number;
      laneXs: number[];
      laneWidth: number;
      originY: number;
      lanes: CaseLaneSpec[];
      ladder: { name: string; unit: UnitName; bands: { rank: number; mw: number; rawLabel: string }[] };
      centerlines: PixelPoint[][];
      laneBounds: { left: PixelPoint[]; right: PixelPoint[] }[];
      origin: PixelPoint;
      truth: { laneIndex: number; bands: { s: number; bp?: number; saturated: boolean }[] }[];
      exposure: { exposureMs: number; gain: number };
    };
    scenarios: ScenarioAsset[];
  };
  files: Record<string, Buffer>;
}

const LADDER_STD = {
  name: 'DL-1k-demo',
  unit: 'bp' as UnitName,
  bands: [
    { rank: 1, mw: 1000, rawLabel: '1000 bp' },
    { rank: 2, mw: 750, rawLabel: '750 bp' },
    { rank: 3, mw: 500, rawLabel: '500 bp' },
    { rank: 4, mw: 300, rawLabel: '300 bp' },
    { rank: 5, mw: 150, rawLabel: '150 bp' },
  ],
};

const W = 300;
const H = 260;
const LANE_XS = [52, 116, 180, 244];
const LANE_W = 26;
const ORIGIN_Y = 26;

const ladderBands = [
  { s: 42, sigma: 5, intensity: 0.9 },
  { s: 78, sigma: 5, intensity: 0.9 },
  { s: 116, sigma: 5, intensity: 0.9 },
  { s: 156, sigma: 5, intensity: 0.9 },
  { s: 198, sigma: 5, intensity: 0.9 },
];

export function buildCasePack(): BuiltCase {
  const files: Record<string, Buffer> = {};

  // ---------- 基线 ----------
  const baselineLanes: SynthLane[] = [
    { role: 'ladder', bands: ladderBands.map((b) => ({ ...b, rankHint: 0 })) },
    {
      role: 'sample',
      bands: [
        { s: 70, sigma: 5, intensity: 0.85 }, // ~810 bp
        { s: 128, sigma: 5, intensity: 0.85 }, // ~440 bp
      ],
    },
    {
      role: 'sample',
      bands: [
        { s: 96, sigma: 5, intensity: 0.8 }, // ~620 bp
        { s: 178, sigma: 5, intensity: 0.8 }, // ~210 bp
      ],
    },
    {
      role: 'sample',
      bands: [{ s: 140, sigma: 5, intensity: 0.8 }], // ~380 bp
    },
  ];

  const base = generateGel({
    width: W,
    height: H,
    laneXs: LANE_XS,
    laneWidth: LANE_W,
    originY: ORIGIN_Y,
    lanes: baselineLanes,
    seed: 7,
  });
  files['baseline.png'] = base.pngBuffer;

  const truth = baselineLanes.map((lane, laneIndex) => ({
    laneIndex,
    bands: lane.bands.map((b, bi) => ({
      s: b.s,
      bp: laneIndex === 0 ? LADDER_STD.bands[bi]!.mw : undefined,
      saturated: b.intensity >= 1,
    })),
  }));

  const scenarios: ScenarioAsset[] = [];

  // 1) 旋转图像：raw 被旋转 90 CCW，orientation 记录 90 CW 修正
  {
    const rotated = rotateGrayPng(base.pngBuffer, 270);
    files['ce-rotation.png'] = rotated.buffer;
    scenarios.push({
      key: 'rotation',
      title: '拍摄方向旋转 90°',
      singleSourceChanged: 'image(rotated)+orientation',
      pngName: 'ce-rotation.png',
      orientationDeg: 90,
      expectCodes: ['ROTATION_FRAME_SHIFT'],
      expected: { ladderBp: LADDER_STD.bands.map((b) => b.mw) },
    });
  }

  // 2) 弯曲泳道（微笑）：ladder 与样本对称侧向弯曲，同一 y 不再同分子量
  {
    const bend = (y: number) => 14 * Math.pow((y - (ORIGIN_Y + 100)) / 110, 2);
    const lanes: SynthLane[] = [
      { role: 'ladder', bend, bands: ladderBands.map((b) => ({ ...b })) },
      { role: 'sample', bend, bands: [{ s: 128, sigma: 5, intensity: 0.85 }] },
      { role: 'sample', bend, bands: [{ s: 96, sigma: 5, intensity: 0.85 }] },
      { role: 'sample', bend, bands: [{ s: 178, sigma: 5, intensity: 0.85 }] },
    ];
    const g = generateGel({ width: W, height: H, laneXs: LANE_XS, laneWidth: LANE_W, originY: ORIGIN_Y, lanes, seed: 11 });
    files['ce-smile.png'] = g.pngBuffer;
    scenarios.push({
      key: 'smile',
      title: '“微笑”弯曲泳道',
      singleSourceChanged: 'lane_trace(curved)',
      pngName: 'ce-smile.png',
      expectCodes: ['SMILE_LOCAL_SCALE'],
      expected: { sampleBands: [{ laneIndex: 1, expectBp: 440 }] },
    });
  }

  // 3) ladder 缺带（500bp 缺失）
  {
    const lanes: SynthLane[] = [
      { role: 'ladder', bands: ladderBands.filter((_, i) => i !== 2).map((b) => ({ ...b })) },
      { role: 'sample', bands: [{ s: 128, sigma: 5, intensity: 0.85 }] },
      { role: 'sample', bands: [{ s: 96, sigma: 5, intensity: 0.85 }] },
      { role: 'sample', bands: [{ s: 178, sigma: 5, intensity: 0.85 }] },
    ];
    const g = generateGel({ width: W, height: H, laneXs: LANE_XS, laneWidth: LANE_W, originY: ORIGIN_Y, lanes, seed: 13 });
    files['ce-missing.png'] = g.pngBuffer;
    scenarios.push({
      key: 'missing_band',
      title: 'ladder 缺带',
      singleSourceChanged: 'image(missing one ladder band)',
      pngName: 'ce-missing.png',
      expectCodes: ['MISSING_LADDER_BAND'],
      expected: { sampleBands: [{ laneIndex: 1, expectBp: 440 }] },
    });
  }

  // 4) 饱和区：样本带强度 1.3 -> 平顶
  {
    const lanes: SynthLane[] = [
      { role: 'ladder', bands: ladderBands.map((b) => ({ ...b })) },
      { role: 'sample', bands: [{ s: 128, sigma: 5, intensity: 1.3 }] },
      { role: 'sample', bands: [{ s: 96, sigma: 5, intensity: 0.85 }] },
      { role: 'sample', bands: [{ s: 178, sigma: 5, intensity: 0.85 }] },
    ];
    const g = generateGel({ width: W, height: H, laneXs: LANE_XS, laneWidth: LANE_W, originY: ORIGIN_Y, lanes, seed: 17 });
    files['ce-saturated.png'] = g.saturatedPixels.length ? g.pngBuffer : g.pngBuffer;
    scenarios.push({
      key: 'saturated',
      title: '饱和条带',
      singleSourceChanged: 'image(saturated sample band)',
      pngName: 'ce-saturated.png',
      expectCodes: ['SATURATED_BAND'],
      expected: { sampleBands: [{ laneIndex: 1, expectInterval: [380, 520] }] },
    });
  }

  // 5) 两条带重叠（中心距 6px）+ 轻微拖尾
  {
    const lanes: SynthLane[] = [
      { role: 'ladder', bands: ladderBands.map((b) => ({ ...b })) },
      {
        role: 'sample',
        bands: [
          { s: 126, sigma: 5, intensity: 0.8 },
          { s: 133, sigma: 5, intensity: 0.8, tail: 'down' },
        ],
      },
      { role: 'sample', bands: [{ s: 96, sigma: 5, intensity: 0.85 }] },
      { role: 'sample', bands: [{ s: 178, sigma: 5, intensity: 0.85 }] },
    ];
    const g = generateGel({ width: W, height: H, laneXs: LANE_XS, laneWidth: LANE_W, originY: ORIGIN_Y, lanes, seed: 19 });
    files['ce-overlap.png'] = g.pngBuffer;
    scenarios.push({
      key: 'overlap',
      title: '两条带重叠 / 拖尾',
      singleSourceChanged: 'image(two close bands)',
      pngName: 'ce-overlap.png',
      expectCodes: ['OVERLAPPING_BANDS'],
      expected: { sampleBands: [{ laneIndex: 1 }] },
    });
  }

  // 6) 非单调标尺：标称 500/750 顺序写反
  {
    const bad = LADDER_STD.bands.map((b) => ({ ...b }));
    bad[1] = { rank: 2, mw: 400, rawLabel: '750 bp (录入为 400)' };
    const g = generateGel({
      width: W,
      height: H,
      laneXs: LANE_XS,
      laneWidth: LANE_W,
      originY: ORIGIN_Y,
      lanes: baselineLanes,
      seed: 23,
    });
    files['ce-nonmono.png'] = g.pngBuffer;
    scenarios.push({
      key: 'nonmonotonic',
      title: '非单调 ladder 标称',
      singleSourceChanged: 'ladder_nominal(non-monotonic)',
      pngName: 'ce-nonmono.png',
      ladderOverride: { name: LADDER_STD.name, unit: 'bp', bands: bad },
      expectCodes: ['NON_MONOTONIC_SCALE'],
      expected: {},
    });
  }

  // 7) 修订后局部失效：先正常分析，再替换一条样本 lane 的曲线（只影响该 lane 依赖）
  {
    const g = generateGel({
      width: W,
      height: H,
      laneXs: LANE_XS,
      laneWidth: LANE_W,
      originY: ORIGIN_Y,
      lanes: baselineLanes,
      seed: 29,
    });
    files['ce-local.png'] = g.pngBuffer;
    scenarios.push({
      key: 'local_failure',
      title: '源数据修订后局部失效',
      singleSourceChanged: 'lane_trace(lane#2 shifted after acceptance)',
      pngName: 'ce-local.png',
      expectCodes: ['LOCAL_DEPENDENCY_INVALID'],
      expected: { sampleBands: [{ laneIndex: 1, expectBp: 440 }] },
    });
  }

  return {
    spec: {
      caseFormat: 'gel-bench-case/1',
      generatedBy: 'gel-bench domain case builder',
      baseline: {
        name: 'DL-1k 四泳道凝胶（基线叙事）',
        pngName: 'baseline.png',
        width: W,
        height: H,
        laneXs: LANE_XS,
        laneWidth: LANE_W,
        originY: ORIGIN_Y,
        lanes: [
          { laneIndex: 0, role: 'ladder', ladderNominal: LADDER_STD.name },
          { laneIndex: 1, role: 'sample' },
          { laneIndex: 2, role: 'sample' },
          { laneIndex: 3, role: 'sample' },
        ],
        ladder: LADDER_STD,
        centerlines: base.centerlines,
        laneBounds: base.laneBounds,
        origin: { x: 0, y: ORIGIN_Y },
        truth,
        exposure: { exposureMs: 500, gain: 1.0 },
      },
      scenarios,
    },
    files,
  };
}

export function stableCaseId(): string {
  return contentId('casepack', { format: 'gel-bench-case/1', name: 'gel-bench-offline-cases' });
}
