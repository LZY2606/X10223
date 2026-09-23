import { createHash } from 'node:crypto';
import type { BandObservation, PixelPoint } from './types.js';

export interface DrawBandSpec {
  laneX: (y: number) => number;
  s: number;
  radiusX?: number;
  radiusY?: number;
  intensity?: number;
  saturated?: boolean;
  offsetX?: number;
}

export interface GelImage {
  width: number;
  height: number;
  pixels: Uint8Array;
  sha256: string;
}

export const GEL_WIDTH = 320;
export const GEL_HEIGHT = 240;

export function createGel(width = GEL_WIDTH, height = GEL_HEIGHT): GelImage {
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const wave = 3 * Math.sin(x / 17) + 2 * Math.sin(y / 13);
      pixels[y * width + x] = Math.max(8, Math.min(45, Math.round(24 + wave)));
    }
  }
  return { width, height, pixels, sha256: hashPixels(pixels) };
}

export function drawBand(pixels: Uint8Array, width: number, height: number, spec: DrawBandSpec): PixelPoint {
  const centerY = Math.round(28 + spec.s);
  const centerX = Math.round(spec.laneX(centerY) + (spec.offsetX ?? 0));
  const radiusX = spec.radiusX ?? 7;
  const radiusY = spec.radiusY ?? 4;
  const intensity = spec.intensity ?? 150;
  for (let y = centerY - radiusY - 4; y <= centerY + radiusY + 5; y += 1) {
    for (let x = centerX - radiusX - 4; x <= centerX + radiusX + 4; x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const tailBoost = spec.saturated ? 0 : (y > centerY ? (y - centerY) * 8 : 0);
      const ellipse =
        ((x - centerX) * (x - centerX)) / ((radiusX + 1) * (radiusX + 1)) +
        ((y - centerY) * (y - centerY)) / ((radiusY + 1) * (radiusY + 1));
      if (ellipse <= 1.2) {
        const value = spec.saturated ? 255 : Math.round(intensity * Math.max(0, 1.15 - ellipse)) + tailBoost;
        const index = y * width + x;
        pixels[index] = Math.max(pixels[index], Math.min(255, value));
      }
    }
  }
  return { x: centerX, y: centerY, coordinateSystem: 'raw-image', unit: 'px' };
}

export function drawTailedBand(pixels: Uint8Array, width: number, height: number, spec: DrawBandSpec): PixelPoint {
  const center = drawBand(pixels, width, height, spec);
  for (let y = center.y; y < center.y + 18; y += 1) {
    for (let x = center.x - 3; x <= center.x + 3; x += 1) {
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      const fade = 100 * (1 - (y - center.y) / 18);
      pixels[y * width + x] = Math.max(pixels[y * width + x], Math.round(fade));
    }
  }
  return center;
}

export function observationFor(center: PixelPoint, overrides: Partial<BandObservation> = {}): BandObservation {
  return {
    peak: center,
    leadingEdgePx: 4,
    trailingEdgePx: 5,
    radiusPx: 7,
    intensity: 160,
    saturated: false,
    ...overrides
  };
}

export function encodePixels(pixels: Uint8Array): string {
  return Buffer.from(pixels).toString('base64');
}

export function hashPixels(pixels: Uint8Array): string {
  return createHash('sha256').update(Buffer.from(pixels)).digest('hex');
}
