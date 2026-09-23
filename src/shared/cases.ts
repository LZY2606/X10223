import type { GelScenario } from './generator.js';
import { fForBp } from './generator.js';

const STD_LADDER = [1500, 1000, 750, 500, 250, 100];

const SAMPLE_TARGETS: { lane: number; bp: number }[] = [
  { lane: 2, bp: 900 },
  { lane: 2, bp: 400 },
  { lane: 3, bp: 1200 },
  { lane: 3, bp: 600 },
  { lane: 3, bp: 200 },
  { lane: 4, bp: 800 },
  { lane: 5, bp: 350 },
  { lane: 6, bp: 1100 },
  { lane: 6, bp: 450 },
];

/**
 * 案例包：1 个基线 + 7 个“只改一个直接来源”的反例。
 * 每个反例相对基线只动一个直接来源，便于检验影响范围。
 */
export function baseScenario(): GelScenario {
  return {
    key: 'baseline',
    title: '基线：正向、直线泳道、完整 ladder',
    width: 520,
    height: 640,
    laneCount: 6,
    marginTop: 60,
    marginBottom: 50,
    ladderBp: [...STD_LADDER],
    exposureRaw: '250 ms',
    orientationRaw: '0°',
    runDurationRaw: '35 min',
    bands: SAMPLE_TARGETS.map((t, i) => ({
      lane: t.lane,
      rank: i + 1,
      f: fForBp(t.bp, { ladderBp: STD_LADDER } as GelScenario),
    })),
  };
}

export function scenarios(): GelScenario[] {
  const base = baseScenario();
  const rotated: GelScenario = {
    ...base,
    key: 'rotated',
    title: '反例1：图像顺时针旋转 90°（只改图像/拍摄方向）',
    rotateCW: 90,
    orientationRaw: '90cw',
  };
  const smile: GelScenario = {
    ...base,
    key: 'smile',
    title: '反例2：“微笑”弯曲泳道（同高度≠同分子量）',
    smilePx: 26,
  };
  const missing: GelScenario = {
    ...base,
    key: 'missing-band',
    title: '反例3：ladder 缺带（750bp 未显带）',
    omitLadderBandOrdinal: 3,
  };
  const saturated: GelScenario = {
    ...base,
    key: 'saturated',
    title: '反例4：饱和平台区（L2 高位置带过曝）',
    bands: [
      ...base.bands,
      { lane: 2, rank: 99, f: fForBp(900, base) - 0.16, plateau: 8, darkness: 240 },
    ],
  };
  const overlap: GelScenario = {
    ...base,
    key: 'overlap',
    title: '反例5：两条带重叠（L4 双峰相距 ~6px）',
    bands: [
      ...base.bands.filter((b) => b.lane !== 4),
      { lane: 4, rank: 1, f: fForBp(820, base), overlapKey: 'g' },
      { lane: 4, rank: 2, f: fForBp(760, base), overlapKey: 'g' },
    ],
  };
  const nonmono: GelScenario = {
    ...base,
    key: 'nonmonotonic',
    title: '反例6：非单调标尺（标称值录入错误）',
    scrambleLadder: true,
  };
  const localFail: GelScenario = {
    ...base,
    key: 'local-invalid',
    title: '反例7：修订后局部失效（L5 条带位于 ladder 有效区外且拖尾）',
    bands: [...base.bands, { lane: 5, rank: 98, f: 0.96, tail: true }],
  };
  return [base, rotated, smile, missing, saturated, overlap, nonmono, localFail];
}
