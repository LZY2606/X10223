import type { GrayImage } from './png';
import { encodePng } from './png';
import { mulberry32 } from '../shared/rng';
import type { Pt } from '../shared/geometry';

export const GEL_WIDTH = 1100;
export const GEL_HEIGHT = 560;
export const WELL_Y = 70;
export const LANE_X = [90, 220, 350, 480, 610, 740, 870, 1000];
export const LANE_HALF_WIDTH = 10;

export const LADDER_NOMINAL = [10000, 5000, 3000, 2000, 1500, 1000, 500, 250];
export const LADDER_REF = 'catalog/DL-10k/ladder-nominal-v1';

export interface GelBandSpec {
  laneIndex: number;
  massBp: number;
  amp?: number;
  sigmaY?: number;
  saturated?: boolean;
  smear?: boolean;
  missing?: boolean;
}

export function migrationY(bp: number): number {
  return WELL_Y + 240 * Math.log10(10000 / bp);
}

export interface GelVariant {
  seed: number;
  smile: boolean;
  bands: GelBandSpec[];
  frameId: string;
}

/** 微笑弯曲：井线成弧、泳道中心线变弯；同一图像高度在不同泳道对应不同迁移量。 */
export function warpPoint(p: Pt): Pt {
  const cx = GEL_WIDTH / 2;
  const half = GEL_WIDTH / 2;
  const nx = (p.x - cx) / half; // -1..1
  const t = Math.min(1, Math.max(0, (p.y - WELL_Y) / (GEL_HEIGHT - WELL_Y - 60)));
  const bowY = 26 * nx * nx * (0.35 + 0.65 * t);
  const bowX = 14 * Math.sin(Math.PI * t) * nx;
  return { x: p.x + bowX, y: p.y + bowY };
}

function drawBand(
  img: Uint8Array,
  cx: number,
  cy: number,
  amp: number,
  sigmaY: number,
  width: number,
  height: number,
  smile: boolean
) {
  const rY = Math.ceil(sigmaY * 3.4);
  const rX = 9;
  for (let dy = -rY; dy <= rY; dy++) {
    for (let dx = -rX; dx <= rX; dx++) {
      // 每个采样点按自身高度映射，保证与泳道采样帧一致
      const q = smile ? warpPoint({ x: cx + dx, y: cy + dy }) : { x: cx + dx, y: cy + dy };
      const x = Math.round(q.x);
      const y = Math.round(q.y);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const gx = Math.exp(-(dx * dx) / (2 * 8 * 8));
      const gy = Math.exp(-(dy * dy) / (2 * sigmaY * sigmaY));
      const add = amp * gx * gy;
      const idx = y * width + x;
      img[idx] = Math.min(255, img[idx] + add);
    }
  }
}

export function baselineBands(): GelBandSpec[] {
  const bands: GelBandSpec[] = LADDER_NOMINAL.map((bp) => ({
    laneIndex: 0,
    massBp: bp,
    amp: 215,
    sigmaY: 5.2
  }));
  const samples: Array<[number, number[], Partial<GelBandSpec>?]> = [
    [1, [4200, 1800, 900]],
    [2, [2500, 1200], { saturated: true }],
    [3, [1700, 1550, 700], { }],
    [4, [2200], { smear: true }],
    [5, [6000, 800]],
    [6, [3500]],
    [7, [950, 460]]
  ];
  for (const [laneIndex, masses, extra] of samples) {
    for (const bp of masses) {
      const doublet = laneIndex === 3 && (bp === 1700 || bp === 1550);
      bands.push({
        laneIndex,
        massBp: bp,
        amp: extra?.saturated && bp === 2500 ? 320 : extra?.smear ? 150 : 210,
        sigmaY: extra?.smear ? 19 : doublet ? 5.0 : 5.4,
        saturated: !!(extra?.saturated && bp === 2500),
        smear: !!extra?.smear
      });
    }
  }
  return bands;
}

export function generateGel(variant: GelVariant): { image: GrayImage; bands: { spec: GelBandSpec; at: Pt }[] } {
  const width = GEL_WIDTH;
  const height = GEL_HEIGHT;
  const pixels = new Uint8Array(width * height);
  const rng = mulberry32(variant.seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const verticalShade = 14 + 10 * (y / height);
      const laneShade = 6 * Math.exp(-((x - GEL_WIDTH / 2) ** 2) / (2 * 520 ** 2));
      const noise = (rng() - 0.5) * 9;
      pixels[y * width + x] = Math.max(0, Math.min(255, verticalShade + laneShade + noise + 8));
    }
  }
  const placed: { spec: GelBandSpec; at: Pt }[] = [];
  for (const spec of variant.bands) {
    if (spec.missing) continue;
    const cx = LANE_X[spec.laneIndex];
    const cy = migrationY(spec.massBp);
    drawBand(
      pixels,
      cx,
      cy,
      spec.amp ?? 210,
      spec.sigmaY ?? 5.4,
      width,
      height,
      variant.smile
    );
    placed.push({ spec, at: variant.smile ? warpPoint({ x: cx, y: cy }) : { x: cx, y: cy } });
  }
  const image: GrayImage = { width, height, pixels, frameId: variant.frameId };
  return { image, bands: placed };
}

export function rotate90CW(img: GrayImage, frameId: string): GrayImage {
  const out = new Uint8Array(img.height * img.width);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const nx = img.height - 1 - y;
      const ny = x;
      out[ny * img.height + nx] = img.pixels[y * img.width + x];
    }
  }
  return { width: img.height, height: img.width, pixels: out, frameId };
}

export function gelPng(variant: GelVariant): Uint8Array {
  return encodePng(generateGel(variant).image);
}
