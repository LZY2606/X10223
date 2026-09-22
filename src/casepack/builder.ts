import {
  baselineRecipe,
  CASE_VARIANTS,
  GEL_H,
  GEL_W,
  KIT_BP,
  LADDER_T,
  ladderNominalMaterial,
  WELL_Y,
} from './recipes';
import {
  centerlineSamples,
  renderGel,
  rotateGray90,
  type GelRecipe,
} from '../core/syntheticGel';
import type {
  BandAnnotation,
  ImageMaterial,
  LadderMaterial,
  LaneAnnotation,
  Orientation,
  ExposureRecord,
} from '../core/types';
import { sha256Hex, stableId } from '../shared/ids';

export interface BuiltCase {
  variantId: string;
  title: string;
  changedSource: string;
  image: ImageMaterial;
  ladder: LadderMaterial;
  lanes: LaneAnnotation[];
  bands: BandAnnotation[];
}

const exposure: ExposureRecord = {
  raw: '0.8 s @ f/2.8, gain 1.0',
  normalized: { seconds: 0.8 },
  metadata: { f: '2.8', gain: '1.0', illuminant: 'UV-302nm' },
};

function imageMaterial(
  recipe: GelRecipe,
  gray: Uint8Array,
  width: number,
  height: number,
  filename: string,
  orientation: Orientation = 'up',
): ImageMaterial {
  const bytes = Buffer.from(gray);
  return {
    materialId: stableId('mat-img', filename, sha256Hex(bytes), width, height, orientation),
    kind: 'raw-gel-image',
    width,
    height,
    grayscale: gray,
    orientation: { declared: orientation, source: 'import-declaration' },
    exposure: { ...exposure },
    origin: { filename, importedAt: '2026-09-22T00:00:00+09:00', sha256: sha256Hex(bytes) },
  };
}

function bandIndexByT(t: number): number {
  // LADDER_T 由 KIT_BP 对数映射生成，按最近 t 还原原始标称序号。
  let best = 0;
  let bestD = Infinity;
  LADDER_T.forEach((tt, i) => {
    const d = Math.abs(tt - t);
    if (d < bestD) { bestD = d; best = i; }
  });
  return best;
}

/** 由配方构造几何真值式标注（中心线/边界/条带中心均为像素级来源）。 */
export function annotationsFromRecipe(
  image: ImageMaterial,
  recipe: GelRecipe,
  producerEventId: string,
  nominalSwap = false,
): { lanes: LaneAnnotation[]; bands: BandAnnotation[] } {
  const usable = recipe.height - WELL_Y - 20;
  const lanes: LaneAnnotation[] = [];
  const bands: BandAnnotation[] = [];

  const ladder = ladderNominalMaterial();
  const nominalByBp = new Map(KIT_BP.map((bp, i) => [bp, ladder.nominals[i]!]));

  recipe.lanes.forEach((synthLane, li) => {
    const samples = centerlineSamples(synthLane, WELL_Y, recipe.height, 4);
    const points = samples.map((p) => ({
      x: Math.round(p.x * 100) / 100,
      y: p.y,
      frame: 'original-pixel' as const,
    }));
    const isLadder = li === 0;
    const label = isLadder ? 'L0' : `L${li}`;
    const laneId = stableId(
      'lane',
      image.materialId,
      synthLane.cx,
      synthLane.bow,
      label,
    );
    lanes.push({
      laneId,
      label,
      centerline: { points },
      halfWidthPx: 12,
      role: isLadder ? 'ladder' : 'sample',
      provenance: {
        role: 'material-source',
        frame: 'original-pixel',
        producerEventId,
        confidence: 1,
        note: `案例配方中心线${synthLane.bow ? `（弯曲 bow=${synthLane.bow}px）` : ''}`,
      },
    });

    synthLane.bands.forEach((bandDef, bi) => {
      // 用中心线采样找该 t 对应（x,y）与弧长。
      const sTarget = bandDef.t * (samples[samples.length - 1]!.s - samples[0]!.s) + samples[0]!.s;
      const near = samples.reduce((best, p) => (Math.abs(p.s - sTarget) < Math.abs(best.s - sTarget) ? p : best));
      const saturated = bandDef.amp > 1;
      const bandId = stableId(
        'band',
        laneId,
        Math.round(bandDef.t * 1000),
        Math.round(bandDef.amp * 100),
        bi,
      );
      let nominalId: string | undefined;
      if (isLadder) {
        // 由该条带配方位序取真实 bp（缺带时 bi 与 KIT_BP 仍对应）。
        let bpIndex = bandIndexByT(bandDef.t);
        if (nominalSwap && bpIndex < 2) bpIndex = 1 - bpIndex; // 交换前两个标称，制造非单调
        nominalId = ladder.nominals[bpIndex]!.nominalId;
        void nominalByBp;
      }
      bands.push({
        bandId,
        laneId,
        center: { x: Math.round(near.x), y: near.y, frame: 'original-pixel' },
        arcLengthPx: Math.round(near.s * 100) / 100,
        peakIntensity: Math.min(255, Math.round(28 + bandDef.amp * 255)),
        saturated,
        overlapsWith: [],
        tailed: (bandDef.tail ?? 0) > 0,
        nominalId,
        provenance: {
          role: 'material-source',
          frame: 'original-pixel',
          producerEventId,
          confidence: 1,
          note: saturated ? '配方设定为饱和（amp>1）' : bandDef.tail ? '配方设定拖尾' : undefined,
        },
      });
    });
  });

  return { lanes, bands: annotateOverlap(bands) };
}

function annotateOverlap(bands: BandAnnotation[]): BandAnnotation[] {
  const out = bands.map((b) => ({ ...b, overlapsWith: [] as string[] }));
  for (let i = 0; i < out.length; i++) {
    for (let j = i + 1; j < out.length; j++) {
      const a = out[i]!;
      const b = out[j]!;
      if (a.laneId !== b.laneId) continue;
      if (Math.abs((a.arcLengthPx ?? 0) - (b.arcLengthPx ?? 0)) < 8) {
        a.overlapsWith.push(b.bandId);
        b.overlapsWith.push(a.bandId);
      }
    }
  }
  return out;
}

export function buildBaseline(): BuiltCase {
  const recipe = baselineRecipe();
  const { gray, width, height } = renderGel(recipe);
  const image = imageMaterial(recipe, gray, width, height, 'casepack/baseline.png');
  const { lanes, bands } = annotationsFromRecipe(image, recipe, 'evt-seed');
  return {
    variantId: 'baseline',
    title: '基线（方向 up / 正常曝光 / 单调 ladder）',
    changedSource: '—（无改动）',
    image,
    ladder: ladderNominalMaterial(),
    lanes,
    bands,
  };
}

export function buildVariant(variantId: string): BuiltCase {
  const variant = CASE_VARIANTS.find((v) => v.id === variantId);
  if (!variant) throw new Error(`未知案例变体 ${variantId}`);
  const recipe = variant.buildRecipe();
  const rendered = renderGel(recipe);
  let gray = rendered.gray;
  let width = rendered.width;
  let height = rendered.height;
  let orientation: Orientation = 'up';

  if (variantId === 'rotation') {
    const r = rotateGray90(gray, width, height, 1);
    gray = r.gray;
    width = r.width;
    height = r.height;
    // 方向声明仍为 up（错误来源），暴露“方向未随旋转更新”。
    orientation = 'up';
  }

  const image = imageMaterial(recipe, gray, width, height, `casepack/${variantId}.png`, orientation);

  if (variantId === 'rotation') {
    // 标注仍来自未旋转配方 → 与像素不一致（故意），用于检出。
    const baseRecipe = baselineRecipe();
    const { lanes, bands } = annotationsFromRecipe(
      { ...image, width: GEL_W, height: GEL_H },
      baseRecipe,
      'evt-seed',
    );
    return { variantId, title: variant.title, changedSource: variant.changedSource, image, ladder: ladderNominalMaterial(), lanes, bands };
  }

  const nominalSwap = variantId === 'nonmonotonic';
  let { lanes, bands } = annotationsFromRecipe(image, recipe, 'evt-seed', nominalSwap);

  if (variantId === 'local-invalidation') {
    // 人工把 L1 第一条样本带拖到最低 ladder 点之下。
    const sampleLane = lanes.find((l) => l.role === 'sample')!;
    const lastPoint = sampleLane.centerline.points[sampleLane.centerline.points.length - 1]!;
    const target = bands.find((b) => b.laneId === sampleLane.laneId)!;
    bands = bands.map((b) =>
      b.bandId === target.bandId
        ? {
            ...b,
            center: { x: Math.round(lastPoint.x), y: lastPoint.y, frame: 'original-pixel' as const },
            arcLengthPx: 9999,
            provenance: { ...b.provenance, role: 'manual-revision' as const, note: '人工拖至最低 ladder 点之下' },
          }
        : b,
    );
  }

  return { variantId, title: variant.title, changedSource: variant.changedSource, image, ladder: ladderNominalMaterial(), lanes, bands };
}

export { KIT_BP, LADDER_T, GEL_W, GEL_H };
