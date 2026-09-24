/**
 * Deterministic synthetic gel used by the offline case pack.
 * Ground-truth geometry lives here so the PNG and the baseline materials agree.
 */

export const GEL_WIDTH = 360;
export const GEL_HEIGHT = 420;
export const LANE_X = [60, 140, 220, 300];

/** "Smile" curvature: vertical shift (px) as a function of x across the gel. */
export function smileOffset(x: number): number {
  return 20 * ((x - 180) / 180) ** 2;
}

/** True (unsmiled) y for a fragment size in bp under the case-pack geometry. */
export function yForBp(bp: number): number {
  return 40 + (3.25 - Math.log10(bp)) * 300;
}

export const LADDER_SIZES_BP = [1500, 1000, 700, 500, 300, 150];

export interface SynthBand {
  lane: number;
  bp: number;
  amplitude: number;
  sigmaX: number;
  sigmaY: number;
  saturate?: boolean;
}

export const SYNTH_BANDS: SynthBand[] = [
  ...LADDER_SIZES_BP.map((bp) => ({ lane: 0, bp, amplitude: 200, sigmaX: 6, sigmaY: 2.4 })),
  { lane: 1, bp: 800, amplitude: 190, sigmaX: 6, sigmaY: 2.4 },
  { lane: 1, bp: 400, amplitude: 170, sigmaX: 6, sigmaY: 2.4 },
  { lane: 2, bp: 600, amplitude: 255, sigmaX: 7, sigmaY: 7.5, saturate: true },
  { lane: 2, bp: 350, amplitude: 150, sigmaX: 6, sigmaY: 2.6 },
  { lane: 2, bp: 330, amplitude: 150, sigmaX: 6, sigmaY: 2.6 },
  { lane: 3, bp: 120, amplitude: 180, sigmaX: 6, sigmaY: 2.4 },
];

/** Deterministic PRNG (LCG) so the case pack image is reproducible. */
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

export function synthesizeGelPixels(): Uint8Array {
  const pixels = new Float64Array(GEL_WIDTH * GEL_HEIGHT);
  const rand = lcg(20260919);
  for (let y = 0; y < GEL_HEIGHT; y++) {
    for (let x = 0; x < GEL_WIDTH; x++) {
      pixels[y * GEL_WIDTH + x] = 18 + 6 * (y / GEL_HEIGHT) + rand() * 4;
    }
  }
  // faint lane background streaks
  for (const lx of LANE_X) {
    for (let y = 0; y < GEL_HEIGHT; y++) {
      const shift = smileOffset(lx);
      for (let dx = -9; dx <= 9; dx++) {
        const x = Math.round(lx + dx);
        if (x < 0 || x >= GEL_WIDTH) continue;
        pixels[y * GEL_WIDTH + x] += 5 * Math.exp(-(dx * dx) / 60);
      }
      void shift;
    }
  }
  for (const band of SYNTH_BANDS) {
    const lx = LANE_X[band.lane];
    const cy = yForBp(band.bp) + smileOffset(lx);
    const ry = Math.ceil(band.sigmaY * 4);
    const rx = Math.ceil(band.sigmaX * 3);
    for (let dy = -ry; dy <= ry; dy++) {
      for (let dx = -rx; dx <= rx; dx++) {
        const x = Math.round(lx + dx);
        const y = Math.round(cy + dy);
        if (x < 0 || x >= GEL_WIDTH || y < 0 || y >= GEL_HEIGHT) continue;
        const g =
          band.amplitude *
          Math.exp(-(dx * dx) / (2 * band.sigmaX * band.sigmaX)) *
          Math.exp(-(dy * dy) / (2 * band.sigmaY * band.sigmaY));
        pixels[y * GEL_WIDTH + x] += g;
      }
    }
  }
  const out = new Uint8Array(GEL_WIDTH * GEL_HEIGHT);
  for (let i = 0; i < out.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(pixels[i])));
  return out;
}
