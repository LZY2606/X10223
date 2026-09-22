import type {
  BandCenterMaterial, FrontCurveMaterial, ImageMaterial, LaneBoundaryMaterial,
  LadderMaterial, PixelPoint, Provenance,
} from '../shared/types.js';
import { sha256 } from './util.js';

/** 迁移模型：y = a - b*log10(bp)，单位 px / bp。 */
export const MIGRATION = { a: 60, b: 184.5 };
export const tForBp = (bp: number) => MIGRATION.a + (4 - Math.log10(bp)) * MIGRATION.b;
export const bpForT = (t: number) => Math.pow(10, 4 - (t - MIGRATION.a) / MIGRATION.b);

export const GEL_W = 480;
export const GEL_H = 360;
export const LANE_X0 = 60;
export const LANE_DX = 60;
export const LANE_COUNT = 7;
export const SMILE_A = 26; // “微笑”弯曲幅度 px

export const smileAt = (x: number) => {
  const cx = GEL_W / 2;
  const u = (x - cx) / cx;
  return SMILE_A * u * u;
};
/** 泳道自身弯曲：x 随 y 摆动。 */
export const laneXAt = (x0: number, y: number) => x0 + 7 * Math.sin((Math.PI * y) / GEL_H);

export interface SampleBandSpec { lane: number; bp: number; saturated?: boolean; smear?: boolean }

export const LADDER_BPS = [10000, 7000, 5000, 3500, 2500, 1500, 1000, 500];
export const LADDER_MISSING_BP = 5000; // ladder 缺带

export const SAMPLE_BANDS: SampleBandSpec[] = [
  { lane: 1, bp: 8000 }, { lane: 1, bp: 3000 }, { lane: 1, bp: 800 },
  { lane: 2, bp: 6000, saturated: true }, { lane: 2, bp: 1200 },
  { lane: 3, bp: 2600 }, { lane: 3, bp: 2450 }, { lane: 3, bp: 900 }, // 2600/2450 两条带重叠
  { lane: 4, bp: 4000 }, { lane: 4, bp: 1500 }, { lane: 4, bp: 600 },
  { lane: 5, bp: 5500 }, { lane: 5, bp: 2000 }, { lane: 5, bp: 300 }, // 300bp 在标尺有效区域之外
  { lane: 6, bp: 9000 }, { lane: 6, bp: 700 },
];

function makeRng(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export interface SynthGel {
  image: ImageMaterial;
  pixels: Uint8Array;
  ladder: LadderMaterial;
  lanes: LaneBoundaryMaterial[];
  frontCurve: FrontCurveMaterial;
  bands: BandCenterMaterial[];
}

function prov(imageId: string, pixel: PixelPoint, source: Provenance['source'], note?: string): Provenance {
  return { source, pixel: { ...pixel }, image_id: imageId, orientation: 'as-captured', note };
}

/** 生成案例包中的合成凝胶：含微笑弯曲、弯曲泳道、缺带、饱和、重叠、有效区域外条带。 */
export function synthesizeGel(imageId = 'mat_image_A'): SynthGel {
  const width = GEL_W, height = GEL_H;
  const pixels = new Uint8Array(width * height);
  const rng = makeRng(1194);
  for (let i = 0; i < pixels.length; i++) pixels[i] = 18 + Math.floor(rng() * 6);

  const drawBand = (cx: number, cy: number, amp: number, sx: number, sy: number, saturate: boolean, smear: boolean) => {
    const r = 16;
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = Math.round(cx + dx), y = Math.round(cy + dy);
        if (x < 0 || y < 0 || x >= width || y >= height) continue;
        const g = amp * Math.exp(-(dx * dx) / (2 * sx * sx) - (dy * dy) / (2 * sy * sy));
        let v = pixels[y * width + x] + g;
        if (smear && dy > 0) v += amp * 0.25 * Math.exp(-dy / 8) * Math.exp(-(dx * dx) / (2 * sx * sx));
        pixels[y * width + x] = saturate ? Math.min(255, v) : Math.min(254, v);
      }
    }
  };

  // ladder 泳道（lane 0）
  const ladderBands: LadderMaterial['bands'] = LADDER_BPS.map((bp, i) => {
    const present = bp !== LADDER_MISSING_BP;
    const t = tForBp(bp);
    const x = laneXAt(LANE_X0, t);
    const y = t + smileAt(x);
    if (present) drawBand(x, y, 190, 5, 2.2, false, false);
    return {
      id: `${imageId}_lad_${i}`,
      nominal_bp: bp,
      present,
      pixel: { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 },
      provenance: prov(imageId, { x, y }, present ? 'auto-detect' : 'import',
        present ? undefined : 'ladder 缺带：胶上未出现，保留标称位置'),
    };
  });

  // 样品条带
  const bands: BandCenterMaterial[] = [];
  let bandIdx = 0;
  for (const spec of SAMPLE_BANDS) {
    const t = tForBp(spec.bp);
    const x = laneXAt(LANE_X0 + spec.lane * LANE_DX, t);
    const y = t + smileAt(x);
    const amp = spec.saturated ? 420 : 200;
    drawBand(x, y, amp, 5.5, 2.4, !!spec.saturated, !!spec.smear);
    const id = `${imageId}_band_${bandIdx++}`;
    bands.push({
      kind: 'band-center',
      id,
      image_id: imageId,
      lane_index: spec.lane,
      pixel: { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 },
      intensity: spec.saturated ? 255 : 205,
      saturated: !!spec.saturated,
      half_height_px: 4,
      provenance: prov(imageId, { x, y }, 'auto-detect',
        spec.saturated ? '饱和：峰顶被截断，中心不可信' : undefined),
    });
  }

  // 泳道中线（弯曲泳道），每 30px 一个像素级来源点
  const lanes: LaneBoundaryMaterial[] = [];
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const x0 = LANE_X0 + lane * LANE_DX;
    const centerline = [];
    for (let y = 20; y <= height - 20; y += 30) {
      const x = laneXAt(x0, y);
      centerline.push({ point: { x: Math.round(x * 10) / 10, y }, provenance: prov(imageId, { x, y }, 'auto-detect') });
    }
    lanes.push({ kind: 'lane-boundary', id: `${imageId}_lane_${lane}`, image_id: imageId, lane_index: lane, centerline });
  }

  // 条带前沿曲线（微笑曲线证据），按泳道采样
  const frontPoints = [];
  const frontT = tForBp(450);
  for (let lane = 0; lane < LANE_COUNT; lane++) {
    const x = laneXAt(LANE_X0 + lane * LANE_DX, frontT);
    const y = frontT + smileAt(x);
    frontPoints.push({ point: { x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 }, provenance: prov(imageId, { x, y }, 'auto-detect') });
  }
  const frontCurve: FrontCurveMaterial = {
    kind: 'front-curve', id: `${imageId}_front`, image_id: imageId, reference_lane: 0, points: frontPoints,
  };

  const image: ImageMaterial = {
    kind: 'image', id: imageId, width, height,
    orientation: 'as-captured',
    exposure: { seconds: 0.8, gain: 2 },
    pixel_digest: sha256(pixels),
  };
  const ladder: LadderMaterial = { kind: 'ladder', id: `${imageId}_ladder`, image_id: imageId, lane_index: 0, label: '1kb ladder', bands: ladderBands };
  return { image, pixels, ladder, lanes, frontCurve, bands };
}

/** 非单调标尺反例：打乱两条 ladder 带的 y，用于触发 semantic_unsolvable。 */
export function scrambledLadder(base: LadderMaterial, id: string): LadderMaterial {
  const bands = base.bands.map((b) => ({ ...b, pixel: { ...b.pixel }, id: `${id}_${b.id.split('_').pop()}` }));
  const a = bands.find((b) => b.nominal_bp === 7000)!;
  const c = bands.find((b) => b.nominal_bp === 2500)!;
  const tmp = a.pixel.y; a.pixel.y = c.pixel.y; c.pixel.y = tmp;
  return { ...base, id, label: '1kb ladder（非单调反例）', bands };
}
