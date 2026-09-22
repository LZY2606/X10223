import { PNG } from 'pngjs';
import { GrayRaster } from './raster.js';
import { FormatCorruptError } from './errors.js';

/** PNG 边缘编解码（业务规则不依赖它）。 */
export function encodePng(raster: GrayRaster): Buffer {
  const png = new PNG({ width: raster.width, height: raster.height });
  for (let i = 0; i < raster.data.length; i++) {
    const g = raster.data[i]!;
    png.data[i * 4] = g;
    png.data[i * 4 + 1] = g;
    png.data[i * 4 + 2] = g;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function decodePngToGray(buf: Buffer): GrayRaster {
  let png: PNG;
  try {
    png = PNG.sync.read(buf);
  } catch (err) {
    throw new FormatCorruptError(`PNG 解码失败：${(err as Error).message}`);
  }
  const out = new GrayRaster(png.width, png.height);
  for (let i = 0; i < out.data.length; i++) {
    const r = png.data[i * 4]!;
    const g = png.data[i * 4 + 1]!;
    const b = png.data[i * 4 + 2]!;
    out.data[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return out;
}
