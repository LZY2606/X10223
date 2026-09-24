import { GrayImage } from '../shared/detect.js';
import { SmileModel } from '../shared/lanes.js';

/** Deterministic PRNG so the offline case pack is byte-stable. */
export function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

export interface BlobSpec {
  cx: number;
  cy: number;
  amplitude: number; // may exceed 255 -> saturation
  sigmaX: number;
  sigmaY: number;
  /** extra tail below the band (trailing) */
  tail?: { amplitude: number; sigmaY: number };
}

export interface GelSpec {
  width: number;
  height: number;
  background: number;
  noise: number;
  seed: number;
  blobs: BlobSpec[];
}

export function renderGel(spec: GelSpec): GrayImage {
  const { width, height } = spec;
  const pixels = new Uint8Array(width * height);
  const rand = lcg(spec.seed);
  const noise: number[] = new Array(width * height);
  for (let i = 0; i < noise.length; i++) noise[i] = (rand() - 0.5) * spec.noise;
  const acc = new Float64Array(width * height);
  for (const b of spec.blobs) {
    const x0 = Math.max(0, Math.floor(b.cx - 4 * b.sigmaX));
    const x1 = Math.min(width - 1, Math.ceil(b.cx + 4 * b.sigmaX));
    const y0 = Math.max(0, Math.floor(b.cy - 4 * b.sigmaY));
    const y1 = Math.min(height - 1, Math.ceil(b.cy + 4 * b.sigmaY));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - b.cx) / b.sigmaX;
        const dy = (y - b.cy) / b.sigmaY;
        acc[y * width + x]! += b.amplitude * Math.exp(-(dx * dx + dy * dy) / 2);
      }
    }
    if (b.tail) {
      const ty1 = Math.min(height - 1, Math.ceil(b.cy + 6 * b.tail.sigmaY));
      for (let y = Math.floor(b.cy); y <= ty1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x - b.cx) / b.sigmaX;
          const dy = (y - b.cy) / b.tail.sigmaY;
          if (dy < 0) continue;
          acc[y * width + x]! += b.tail.amplitude * Math.exp(-(dx * dx + dy * dy) / 2);
        }
      }
    }
  }
  for (let i = 0; i < pixels.length; i++) {
    const v = spec.background + acc[i]! + noise[i]!;
    pixels[i] = v < 0 ? 0 : v > 255 ? 255 : Math.round(v);
  }
  return { width, height, pixels };
}

/** rotate a grayscale image 90 degrees clockwise */
export function rotate90cw(img: GrayImage): GrayImage {
  const out = new Uint8Array(img.width * img.height);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const nx = img.height - 1 - y;
      const ny = x;
      out[ny * img.height + nx] = img.pixels[y * img.width + x]!;
    }
  }
  return { width: img.height, height: img.width, pixels: out };
}

/** map a point from original image space into 90cw-rotated image space */
export function rotatePoint90cw(x: number, y: number, originalHeight: number): { x: number; y: number } {
  return { x: originalHeight - 1 - y, y: x };
}

export const CASE_SMILE: SmileModel = { a: 18, cx: 180, w: 180 };

/** y = top + (logTop - log10(mw)) * pxPerLog */
export function mwToY(mw: number, top: number, logTop: number, pxPerLog: number): number {
  return top + (logTop - Math.log10(mw)) * pxPerLog;
}
