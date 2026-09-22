import type { GelRecipe } from '../core/syntheticGel';
import { parseMolecularWeight } from '../shared/units';
import { stableId } from '../shared/ids';

/**
 * 领域离线案例包：不使用通用表格，材料是真实的“胶/泳道/条带”配方。
 * 基线 + 7 类“只改一个直接来源”的反例。
 */
export const KIT_BP = [1500, 1000, 750, 500, 300, 150];

export const GEL_W = 360;
export const GEL_H = 300;
export const WELL_Y = 36;

export function ladderNominalMaterial(kitId = 'demo-100bp-ish') {
  const nominals = KIT_BP.map((bp, i) => {
    const raw = bp >= 1000 ? `${bp / 1000} kbp` : `${bp} bp`;
    const quantity = parseMolecularWeight(raw);
    return {
      nominalId: stableId('nom', kitId, raw, i),
      quantity,
      expectedIndex: i,
    };
  });
  return {
    materialId: stableId('mat-ladder', kitId, KIT_BP.join('-')),
    kind: 'ladder-spec' as const,
    kitName: 'DemoLadder-150-1500（离线案例）',
    nominals,
    origin: { source: 'casepack/recipes.ts', importedAt: '2026-09-22T00:00:00+09:00' },
  };
}

/** ladder 道六个标称位置；样本道若干，含一个故意重叠对、一个饱和、一个拖尾在变体中开启。 */
function ladderTs() {
  // t 必须随 bp 减小而增大（迁移更远）。用近似对数关系。
  const bp = KIT_BP;
  const z = bp.map((v) => Math.log10(v));
  const zMin = Math.min(...z);
  const zMax = Math.max(...z);
  const t0 = 0.12;
  const t1 = 0.9;
  return z.map((v) => Math.round((t0 + ((zMax - v) / (zMax - zMin)) * (t1 - t0)) * 1000) / 1000);
}

export const LADDER_T = ladderTs();

export interface CaseVariant {
  id: string;
  title: string;
  /** 只改动的那个直接来源。 */
  changedSource: string;
  buildRecipe: () => GelRecipe;
}

function baseBands(opts: { saturate?: boolean; overlap?: boolean; tail?: boolean } = {}) {
  const ladder = LADDER_T.map((t) => ({ t, amp: 0.85, sigmaX: 7, sigmaY: 4 }));
  const sample: { t: number; amp: number; sigmaX: number; sigmaY: number; tail?: number }[] = [
    { t: 0.3, amp: 0.7, sigmaX: 7, sigmaY: 4 },
    { t: 0.5, amp: 0.72, sigmaX: 7, sigmaY: 4 },
    { t: 0.72, amp: 0.68, sigmaX: 7, sigmaY: 4 },
  ];
  if (opts.tail) sample[1] = { ...sample[1]!, t: 0.5, tail: 2.2 };
  if (opts.saturate) sample[0] = { ...sample[0]!, amp: 1.25 };
  if (opts.overlap) sample.push({ t: 0.318, amp: 0.6, sigmaX: 7, sigmaY: 4 });
  return { ladder, sample };
}

function recipe(mut: (r: GelRecipe) => GelRecipe = (x) => x): GelRecipe {
  const { ladder, sample } = baseBands();
  const lanes = [
    { cx: 60, bow: 0, bands: ladder },
    { cx: 150, bow: 0, bands: sample },
    { cx: 240, bow: 0, bands: [
      { t: 0.36, amp: 0.7, sigmaX: 7, sigmaY: 4 },
      { t: 0.6, amp: 0.7, sigmaX: 7, sigmaY: 4 },
    ] },
  ];
  return mut({
    width: GEL_W,
    height: GEL_H,
    background: 28,
    noise: 7,
    wellY: WELL_Y,
    lanes,
    seed: 20260922,
  });
}

export const CASE_VARIANTS: CaseVariant[] = [
  {
    id: 'rotation',
    title: '旋转图像',
    changedSource: 'raw-gel-image（顺时针旋转 90°，方向声明保持 up）',
    buildRecipe: () => recipe((r) => ({ ...r, seed: r.seed })),
  },
  {
    id: 'smile',
    title: '弯曲泳道（微笑）',
    changedSource: 'lane 几何：样本道 bow=22px',
    buildRecipe: () =>
      recipe((r) => ({
        ...r,
        lanes: r.lanes.map((l, i) => (i === 1 ? { ...l, bow: 22 } : l)),
      })),
  },
  {
    id: 'missing-band',
    title: 'ladder 缺带',
    changedSource: 'ladder 道像素：删除 500bp 对应条带',
    buildRecipe: () =>
      recipe((r) => ({
        ...r,
        lanes: r.lanes.map((l, i) =>
          i === 0
            ? { ...l, bands: l.bands.filter((_, bi) => KIT_BP[bi] !== 500) }
            : l,
        ),
      })),
  },
  {
    id: 'saturation',
    title: '饱和区',
    changedSource: '样本道条带曝光：amp=1.25（截断到 255）',
    buildRecipe: () =>
      recipe((r) => ({
        ...r,
        lanes: r.lanes.map((l, i) =>
          i === 1
            ? { ...l, bands: l.bands.map((b, bi) => (bi === 0 ? { ...b, amp: 1.25 } : b)) }
            : l,
        ),
      })),
  },
  {
    id: 'overlap',
    title: '两条带重叠',
    changedSource: '样本道：在 0.30 与 0.318 放两条近带',
    buildRecipe: () =>
      recipe((r) => ({
        ...r,
        lanes: r.lanes.map((l, i) =>
          i === 1
            ? {
                ...l,
                bands: [...l.bands, { t: 0.318, amp: 0.62, sigmaX: 7, sigmaY: 4 }],
              }
            : l,
        ),
      })),
  },
  {
    id: 'nonmonotonic',
    title: '非单调标尺',
    changedSource: 'ladder 标称绑定：交换两条 ladder band 的标称值',
    buildRecipe: () => recipe(),
  },
  {
    id: 'local-invalidation',
    title: '修订后局部失效',
    changedSource: '人工把一条样本带拖到最低 ladder 点之下（出有效区域）',
    buildRecipe: () => recipe(),
  },
];

export function baselineRecipe(): GelRecipe {
  return recipe();
}
