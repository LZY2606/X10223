import { PNG } from 'pngjs';
import type { PixelPoint } from './types.js';
import { rotatePoint } from './geometry.js';

/** 简单 RGBA 光栅；业务规则直接操作像素数组，便于测试。 */
export interface Raster {
  width: number;
  height: number;
  channels: 4;
  data: Uint8Array; // RGBA
}

export function createRaster(width: number, height: number, fill: [number, number, number, number] = [245, 245, 240, 255]): Raster {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < width * height; i++) data.set(fill, i * 4);
  return { width, height, channels: 4, data };
}

export function decodePng(bytes: Uint8Array): Raster {
  const png = PNG.sync.read(Buffer.from(bytes));
  return { width: png.width, height: png.height, channels: 4, data: new Uint8Array(png.data) };
}

export function encodePng(raster: Raster): Uint8Array {
  const png = new PNG({ width: raster.width, height: raster.height });
  png.data = Buffer.from(raster.data);
  return new Uint8Array(PNG.sync.write(png));
}

export function setPixel(r: Raster, x: number, y: number, c: [number, number, number, number]): void {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  r.data.set(c, (y * r.width + x) * 4);
}

export function getPixel(r: Raster, x: number, y: number): [number, number, number, number] {
  const i = (y * r.width + x) * 4;
  return [r.data[i], r.data[i + 1], r.data[i + 2], r.data[i + 3]];
}

/** 灰度：暗带=低值。 */
export function grayAt(r: Raster, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return 255;
  const i = (Math.round(y) * r.width + Math.round(x)) * 4;
  return 0.299 * r.data[i] + 0.587 * r.data[i + 1] + 0.114 * r.data[i + 2];
}

/** 在 (x,y) 画一个高斯暗斑（条带）。peak 0..255 为暗度；plateau 时中心削平。 */
export function paintBand(
  r: Raster,
  cx: number,
  cy: number,
  sigmaX: number,
  sigmaY: number,
  darkness: number,
  opts: { plateau?: number; tailSide?: 1 | -1 | 0 } = {},
): void {
  const radius = Math.ceil(Math.max(sigmaX, sigmaY) * 3 + (opts.plateau ?? 0));
  for (let y = Math.max(0, Math.floor(cy - radius)); y <= Math.min(r.height - 1, Math.ceil(cy + radius)); y++) {
    for (let x = Math.max(0, Math.floor(cx - radius)); x <= Math.min(r.width - 1, Math.ceil(cx + radius)); x++) {
      let gx = (x - cx) / sigmaX;
      const gy = (y - cy) / sigmaY;
      if (opts.tailSide) gx *= gx * opts.tailSide > 0 ? 1.55 : 0.85;
      let dark = darkness * Math.exp(-0.5 * (gx * gx + gy * gy));
      if (opts.plateau) {
        const within = Math.abs(x - cx) <= opts.plateau && Math.abs(y - cy) <= sigmaY * 0.8;
        if (within) dark = darkness; // 削平→饱和
      }
      const i = (y * r.width + x) * 4;
      for (let k = 0; k < 3; k++) r.data[i + k] = Math.max(0, r.data[i + k] - dark);
      r.data[i + 3] = 255;
    }
  }
}

export function rotateRasterCW(src: Raster, deg: number): Raster {
  const d = ((deg % 360) + 360) % 360;
  if (d === 0) return { ...src, data: new Uint8Array(src.data) };
  const swap = d === 90 || d === 270;
  const w = swap ? src.height : src.width;
  const h = swap ? src.width : src.height;
  const out = createRaster(w, h, [0, 0, 0, 255]);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const np = rotatePoint({ x, y }, d, src.width, src.height);
      const si = (y * src.width + x) * 4;
      const di = (np.y * w + np.x) * 4;
      out.data[di] = src.data[si];
      out.data[di + 1] = src.data[si + 1];
      out.data[di + 2] = src.data[si + 2];
      out.data[di + 3] = src.data[si + 3];
    }
  }
  return out;
}

/**
 * 沿中心线在弧长 s 处取横截面平均灰度（越暗值越小）。
 * 在切线法向 ±lateralHalfWidth、沿切线 ±axialHalf 窗口内平均。
 */
export function sampleCrossSection(
  r: Raster,
  center: PixelPoint,
  tangent: PixelPoint,
  axialHalf: number,
  lateralHalf: number,
): number {
  const nx = -tangent.y;
  const ny = tangent.x;
  let sum = 0;
  let n = 0;
  for (let a = -axialHalf; a <= axialHalf; a++) {
    for (let b = -lateralHalf; b <= lateralHalf; b++) {
      const x = center.x + tangent.x * a + nx * b;
      const y = center.y + tangent.y * a + ny * b;
      sum += grayAt(r, x, y);
      n++;
    }
  }
  return n ? sum / n : 255;
}
