/**
 * 离线案例包：胶道标尺领域材料（不是通用表格）。
 * 基线完整保留 原图/拍摄方向/曝光/ladder 标称/lane 边界/条带中心 的像素级来源；
 * 随后安排：参数修订、只影响局部依赖的源数据改动、互相冲突的人工决定。
 * 反例档案：每个分支相对基线只改动一个直接来源。
 */
import { generateGel, type SynGelSpec, type SynBand } from './gelgen.js';

export const GEL_W = 320;
export const GEL_H = 420;
export const LANE_TOP = 28;
export const LANE_BOTTOM = GEL_H - 28;

/** 常见 dsDNA ladder 标称（bp），自上而下迁移 */
export const LADDER_BP = [1500, 1000, 750, 500, 400, 300, 200, 150, 100, 50];

/** 迁移模型：u = 30 + 150*log10(1500/mw)，使标称点近似线性、可标定 */
export function migrationU(mw: number): number {
  return 30 + 150 * Math.log10(1500 / mw);
}

export interface ScenarioBand extends SynBand {
  /** ladder 标称 bp（ladder lane 用） */
  mw?: number;
  label?: string;
}

export type ScenarioKind =
  | 'baseline'
  | 'rotation'
  | 'smile'
  | 'ladder-missing'
  | 'saturation'
  | 'overlap'
  | 'nonmonotonic'
  | 'revision-local-invalidation'
  | 'conflicting-decisions';

export interface ScenarioSpec {
  kind: ScenarioKind;
  title: string;
  /** 相对基线只改动的直接来源（反例分支） */
  changedDirectSource: string | null;
  /** ladder lane 的微笑二次项 */
  ladderSmile: number;
  sampleSmile: number;
  /** 旋转角度（顺时针 quarter），由外层在生成后旋转 */
  rotateQuarters: number;
  /** ladder 标称修改（ordinal -> 覆盖 bp；置 null 表示该带在图中缺失） */
  ladderOverride: Record<number, number | null>;
  /** 是否让标尺非单调：交换两个标称（直接来源=ladder 标称） */
  nonMonotonic: boolean;
  /** 饱和样本带 ordinal 集合 */
  saturatedOrdinals: number[];
  /** 重叠：额外插入一条与指定样本带靠近的带（{near, offsetU, amp}） */
  overlap: { near: number; offsetU: number; amp: number } | null;
  /** 修订后局部失效：把某样本带中心移动到有效区域之外（只改一个 band 直接来源） */
  movedBand?: { ordinal: number; dY: number };
  seed: number;
}

const SAMPLE_LANES: { id: string; label: string; xCenter: number; mws: number[] }[] = [
  { id: 'lane-s1', label: '样本泳道 1', xCenter: 118, mws: [900, 650, 450, 260, 180, 90] },
  { id: 'lane-s2', label: '样本泳道 2', xCenter: 172, mws: [1200, 700, 350, 220, 130] },
  { id: 'lane-s3', label: '样本泳道 3', xCenter: 226, mws: [800, 500, 300, 170, 70] }
];

export function scenarioSpec(kind: ScenarioKind): ScenarioSpec {
  const base: ScenarioSpec = {
    kind,
    title: '',
    changedDirectSource: null,
    ladderSmile: 0,
    sampleSmile: 0,
    rotateQuarters: 0,
    ladderOverride: {},
    nonMonotonic: false,
    saturatedOrdinals: [],
    overlap: null,
    seed: 1194
  };
  switch (kind) {
    case 'baseline':
      return { ...base, title: '基线：全部材料像素级来源完整' };
    case 'rotation':
      return {
        ...base,
        title: '旋转图像：帧改变后几何来源必须同步换帧',
        changedDirectSource: 'rawImage.orientation',
        rotateQuarters: 1,
        seed: 1195
      };
    case 'smile':
      return {
        ...base,
        title: '微笑弯曲：同一高度不等于同一分子量，局部标尺带有效区域',
        changedDirectSource: 'laneGeometry',
        ladderSmile: 26,
        sampleSmile: 30,
        seed: 1196
      };
    case 'ladder-missing':
      return {
        ...base,
        title: 'ladder 缺带：受影响插值段不可用，标称材料保留',
        changedDirectSource: 'ladderSpec.band#5',
        ladderOverride: { 5: null },
        seed: 1197
      };
    case 'saturation':
      return {
        ...base,
        title: '饱和区：削顶条带只能作为候选',
        changedDirectSource: 'exposure.level',
        saturatedOrdinals: [2, 4],
        seed: 1198
      };
    case 'overlap':
      return {
        ...base,
        title: '两条带重叠：分子量只能给出区间并保留全部候选',
        changedDirectSource: 'band.center.lane-s1-b4',
        overlap: { near: 4, offsetU: 7, amp: 120 },
        seed: 1199
      };
    case 'nonmonotonic':
      return {
        ...base,
        title: '非单调标尺：禁止插值（语义无解）',
        changedDirectSource: 'ladderSpec.nominal.swap',
        nonMonotonic: true,
        seed: 1200
      };
    case 'revision-local-invalidation':
      return {
        ...base,
        title: '修订后局部失效：只移动一条带，影响不得扩散',
        changedDirectSource: 'band.center.lane-s2-b3',
        ladderSmile: 14,
        sampleSmile: 14,
        movedBand: { ordinal: 3, dY: 96 },
        seed: 1201
      };
    case 'conflicting-decisions':
      return {
        ...base,
        title: '互相冲突的人工决定：采纳与未采纳结果都保留',
        ladderSmile: 8,
        sampleSmile: 8,
        saturatedOrdinals: [5],
        seed: 1202
      };
  }
}

export interface BuiltScenario {
  spec: ScenarioSpec;
  gel: ReturnType<typeof generateGel>;
  /** ladder 标称（含覆盖与缺失），按 ordinal */
  ladderNominals: { ordinal: number; mw: number | null; observed: boolean }[];
}

export function buildScenario(kind: ScenarioKind): BuiltScenario {
  const spec = scenarioSpec(kind);

  // ladder 标称（非单调：交换 400/500 两个相邻标称）
  const nominalMap = new Map<number, number | null>();
  LADDER_BP.forEach((mw, i) => {
    const ordinal = i + 1;
    let v: number | null = mw;
    if (spec.nonMonotonic && ordinal === 4) v = LADDER_BP[4]!;
    else if (spec.nonMonotonic && ordinal === 5) v = LADDER_BP[3]!;
    if (Object.prototype.hasOwnProperty.call(spec.ladderOverride, ordinal)) {
      v = spec.ladderOverride[ordinal]!;
    }
    nominalMap.set(ordinal, v);
  });

  const ladderBands: ScenarioBand[] = [];
  LADDER_BP.forEach((_, i) => {
    const ordinal = i + 1;
    const nominal = nominalMap.get(ordinal);
    if (nominal === null) return; // 缺带：图上也不画
    ladderBands.push({ u: migrationU(LADDER_BP[i]!), amp: 190, sigmaU: 3.2, mw: nominal, label: `L${ordinal}` });
  });

  const lanes = [
    {
      id: 'lane-ladder',
      label: 'Ladder',
      xCenter: 64,
      halfWidth: 16,
      smile: spec.ladderSmile,
      isLadder: true,
      bands: ladderBands
    },
    ...SAMPLE_LANES.map((sl) => {
      const bands: ScenarioBand[] = sl.mws.map((mw, i) => {
        const ordinal = i + 1;
        const sat = spec.saturatedOrdinals.includes(ordinal);
        return {
          u: migrationU(mw),
          amp: sat ? 255 : 150 + ((i * 17) % 40),
          sigmaU: 3.4,
          tail: ordinal === 3 && spec.kind === 'saturation' ? 1.6 : undefined,
          mw,
          label: `${sl.id}-b${ordinal}`
        };
      });
      if (spec.overlap && sl.id === 'lane-s1') {
        const anchor = sl.mws[spec.overlap.near - 1]!;
        bands.push({
          u: migrationU(anchor) + spec.overlap.offsetU,
          amp: spec.overlap.amp,
          sigmaU: 3.4,
          label: `${sl.id}-b${spec.overlap.near}x`
        });
      }
      return {
        id: sl.id,
        label: sl.label,
        xCenter: sl.xCenter,
        halfWidth: 16,
        smile: spec.sampleSmile,
        bands
      };
    })
  ];

  const gelSpec: SynGelSpec = {
    width: GEL_W,
    height: GEL_H,
    background: 18,
    noiseAmp: 6,
    lanes,
    seed: spec.seed
  };
  const gel = generateGel(gelSpec);

  const ladderNominals = LADDER_BP.map((_, i) => {
    const ordinal = i + 1;
    const nominal = nominalMap.get(ordinal) ?? null;
    return { ordinal, mw: nominal, observed: nominal !== null };
  });

  return { spec, gel, ladderNominals };
}

export { SAMPLE_LANES };
