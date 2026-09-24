import { encodeGrayPng } from './png.ts';

/** Synthetic gel image generator used by the offline case pack.
 *  Produces a grayscale PNG plus the ground-truth band geometry so the
 *  case pack can declare pixel-level provenance for every band center. */

export interface GelBandSpec {
  lane: number;
  size_bp: number;
  intensity: number;
  saturated?: boolean;
  tailing?: boolean;
}

export interface GelImageSpec {
  width: number;
  height: number;
  lanes: { x0: number; x1: number }[];
  smile_k: number;
  y_for_size: { top_bp: number; bottom_bp: number; y_top: number; y_bottom: number };
  bands: GelBandSpec[];
  saturated_regions?: { x: number; y: number; w: number; h: number }[];
}

export function yForSize(spec: GelImageSpec['y_for_size'], sizeBp: number): number {
  const t = (Math.log10(spec.top_bp) - Math.log10(sizeBp)) / (Math.log10(spec.top_bp) - Math.log10(spec.bottom_bp));
  return spec.y_top + t * (spec.y_bottom - spec.y_top);
}

export function renderGelImage(spec: GelImageSpec): { png: Buffer; bandCenters: { lane: number; size_bp: number; x: number; y: number }[] } {
  const { width, height } = spec;
  const px = new Float64Array(width * height);
  // background
  for (let i = 0; i < px.length; i++) px[i] = 18;
  const xMid = width / 2;
  const bandCenters: { lane: number; size_bp: number; x: number; y: number }[] = [];

  for (const band of spec.bands) {
    const lane = spec.lanes[band.lane];
    const xc = (lane.x0 + lane.x1) / 2;
    const yTrue = yForSize(spec.y_for_size, band.size_bp);
    const yApp = yTrue + spec.smile_k * (xc - xMid) * (xc - xMid);
    bandCenters.push({ lane: band.lane, size_bp: band.size_bp, x: xc, y: yApp });
    const sigmaX = (lane.x1 - lane.x0) / 6;
    const sigmaY = 2.2;
    const tail = band.tailing ? 6 : 0;
    for (let y = Math.max(0, Math.floor(yApp - 8)); y <= Math.min(height - 1, Math.ceil(yApp + 8 + tail * 3)); y++) {
      for (let x = Math.max(0, Math.floor(xc - 3 * sigmaX)); x <= Math.min(width - 1, Math.ceil(xc + 3 * sigmaX)); x++) {
        const dy = y >= yApp ? (y - yApp) / (sigmaY + (band.tailing ? (y - yApp) * 0.35 : 0)) : (y - yApp) / sigmaY;
        const dx = (x - xc) / sigmaX;
        const v = band.intensity * Math.exp(-0.5 * (dx * dx + dy * dy));
        const idx = y * width + x;
        px[idx] = Math.max(px[idx], 18 + v);
      }
    }
  }

  // lane glow
  for (const lane of spec.lanes) {
    const xc = (lane.x0 + lane.x1) / 2;
    for (let y = 0; y < height; y++) {
      for (let x = Math.floor(lane.x0); x <= Math.ceil(lane.x1) && x < width; x++) {
        const d = Math.abs(x - xc) / ((lane.x1 - lane.x0) / 2);
        const idx = y * width + x;
        px[idx] = Math.max(px[idx], 18 + 10 * (1 - d));
      }
    }
  }

  let out = new Uint8Array(width * height);
  for (let i = 0; i < px.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(px[i])));

  // saturated regions: clipped flat-top at 255
  for (const r of spec.saturated_regions ?? []) {
    for (let y = r.y; y < r.y + r.h && y < height; y++) {
      for (let x = r.x; x < r.x + r.w && x < width; x++) {
        if (out[y * width + x] > 200) out[y * width + x] = 255;
      }
    }
  }

  return { png: encodeGrayPng(width, height, out), bandCenters };
}

/** Mean intensity in a small window around a pixel, with provenance. */
export function sampleIntensity(pixels: Uint8Array, width: number, height: number, x: number, y: number, radius = 2): number {
  let sum = 0;
  let n = 0;
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      const xx = Math.round(x) + dx;
      const yy = Math.round(y) + dy;
      if (xx >= 0 && xx < width && yy >= 0 && yy < height) {
        sum += pixels[yy * width + xx];
        n++;
      }
    }
  }
  return n ? sum / n : 0;
}
