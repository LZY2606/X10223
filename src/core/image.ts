/**
 * Grayscale image helpers shared by the synthetic case generator, analysis
 * pipeline and (indirectly) tests. Pure functions over row-major Uint8Array
 * buffers so the server and storage layers can call them without a browser.
 */
import { PNG } from 'pngjs';
import { sha256Hex } from './identity.js';

export interface GrayImage {
  width: number;
  height: number;
  pixels: Uint8Array; // 0..255
}

export function makeImage(width: number, height: number, fill = 32): GrayImage {
  return { width, height, pixels: new Uint8Array(width * height).fill(fill) };
}

export function idx(img: GrayImage, x: number, y: number): number {
  return y * img.width + x;
}

export function inBounds(img: GrayImage, x: number, y: number): boolean {
  return x >= 0 && y >= 0 && x < img.width && y < img.height;
}

export function sampleBilinear(img: GrayImage, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  if (!inBounds(img, x0, y0) || !inBounds(img, x1, y1)) {
    const xi = Math.max(0, Math.min(img.width - 1, Math.round(x)));
    const yi = Math.max(0, Math.min(img.height - 1, Math.round(y)));
    return img.pixels[idx(img, xi, yi)];
  }
  const fx = x - x0;
  const fy = y - y0;
  const p00 = img.pixels[idx(img, x0, y0)];
  const p10 = img.pixels[idx(img, x1, y0)];
  const p01 = img.pixels[idx(img, x0, y1)];
  const p11 = img.pixels[idx(img, x1, y1)];
  return p00 * (1 - fx) * (1 - fy) + p10 * fx * (1 - fy) + p01 * (1 - fx) * fy + p11 * fx * fy;
}

/** Paint an additive Gaussian band blob, clipped at 255 to allow saturation. */
export function paintGaussianBand(
  img: GrayImage,
  cx: number,
  cy: number,
  sigmaX: number,
  sigmaY: number,
  amplitude: number,
): void {
  const radius = Math.ceil(3 * Math.max(sigmaX, sigmaY));
  const xMin = Math.max(0, Math.floor(cx - radius));
  const xMax = Math.min(img.width - 1, Math.ceil(cx + radius));
  const yMin = Math.max(0, Math.floor(cy - radius));
  const yMax = Math.min(img.height - 1, Math.ceil(cy + radius));
  for (let y = yMin; y <= yMax; y++) {
    for (let x = xMin; x <= xMax; x++) {
      const gx = ((x - cx) / sigmaX) ** 2;
      const gy = ((y - cy) / sigmaY) ** 2;
      const add = amplitude * Math.exp(-0.5 * (gx + gy));
      const at = idx(img, x, y);
      img.pixels[at] = Math.min(255, img.pixels[at] + add);
    }
  }
}

export function addNoise(img: GrayImage, amount: number, rand: () => number): void {
  for (let i = 0; i < img.pixels.length; i++) {
    const n = (rand() - 0.5) * 2 * amount;
    img.pixels[i] = Math.max(0, Math.min(255, img.pixels[i] + n));
  }
}

/** Rotate clockwise by 0/90/180/270 degrees. */
export function rotateClockwise(img: GrayImage, deg: 0 | 90 | 180 | 270): GrayImage {
  if (deg === 0) return { ...img, pixels: img.pixels.slice() };
  const turns = (deg / 90) % 4;
  let cur = img;
  for (let t = 0; t < turns; t++) {
    cur = rotate90CW(cur);
  }
  return cur;
}

function rotate90CW(img: GrayImage): GrayImage {
  const out = makeImage(img.height, img.width, 0);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const nx = img.height - 1 - y;
      const ny = x;
      out.pixels[ny * out.width + nx] = img.pixels[y * img.width + x];
    }
  }
  return out;
}

export function encodePngBase64(img: GrayImage): string {
  const png = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.pixels.length; i++) {
    const v = img.pixels[i];
    png.data[i * 4] = v;
    png.data[i * 4 + 1] = v;
    png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png).toString('base64');
}

export function decodePng(buffer: Uint8Array | Buffer): GrayImage {
  const png = PNG.sync.read(Buffer.from(buffer));
  const gray = makeImage(png.width, png.height, 0);
  for (let i = 0; i < gray.pixels.length; i++) {
    gray.pixels[i] = Math.round(0.299 * png.data[i * 4] + 0.587 * png.data[i * 4 + 1] + 0.114 * png.data[i * 4 + 2]);
  }
  return gray;
}

export function imageFingerprint(img: GrayImage): { sha256: string } {
  return { sha256: sha256Hex(img.pixels) };
}
