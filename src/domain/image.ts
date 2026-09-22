import { PNG } from 'pngjs';
import type { PixelImage } from './geometry.js';

export type LoadResult =
  | { ok: true; image: PixelImage }
  | { ok: false; code: 'CORRUPT_FORMAT'; message: string };

export function decodePng(buf: Buffer): LoadResult {
  let png: PNG;
  try {
    png = PNG.sync.read(buf);
  } catch (err) {
    return { ok: false, code: 'CORRUPT_FORMAT', message: `PNG 解码失败: ${(err as Error).message}` };
  }
  const gray = new Uint8Array(png.width * png.height);
  for (let i = 0, j = 0; i < png.data.length; i += 4, j++) {
    gray[j] = (png.data[i] + png.data[i + 1] + png.data[i + 2]) / 3;
  }
  return { ok: true, image: { width: png.width, height: png.height, gray } };
}

// 预算检查：资源耗尽与格式损坏是两种不同结果
export function checkPixelBudget(img: PixelImage, maxPixels: number) {
  return img.gray.length <= maxPixels
    ? null
    : { code: 'BUDGET_EXHAUSTED' as const, used: img.gray.length, limit: maxPixels };
}
