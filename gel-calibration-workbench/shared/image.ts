import { PNG } from 'pngjs';
import type { Point } from './types.js';
import { ellipseContour } from './geometry.js';

/** 灰度图（0..255；凝胶暗背景亮条带） */
export interface GrayImage {
  width: number;
  height: number;
  data: Uint8Array;
}

export function decodePng(bytes: Uint8Array): GrayImage {
  const png = PNG.sync.parse(Buffer.from(bytes));
  const g = new Uint8Array(png.width * png.height);
  for (let i = 0; i < g.length; i++) {
    const r = png.data[i * 4]!;
    const gg = png.data[i * 4 + 1]!;
    const b = png.data[i * 4 + 2]!;
    g[i] = Math.round(0.299 * r + 0.587 * gg + 0.114 * b);
  }
  return { width: png.width, height: png.height, data: g };
}

export function encodePng(img: GrayImage): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.data.length; i++) {
    png.data[i * 4] = img.data[i]!;
    png.data[i * 4 + 1] = img.data[i]!;
    png.data[i * 4 + 2] = img.data[i]!;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

export function at(img: GrayImage, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return 0;
  return img.data[y * img.width + x]!;
}

export function setPx(img: GrayImage, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= img.width || y >= img.height) return;
  img.data[y * img.width + x] = Math.max(0, Math.min(255, Math.round(v)));
}

export function rotate90CW(img: GrayImage): GrayImage {
  const out = new GrayImage2(img.height, img.width);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) out.data[(x) * out.width + (out.width - 1 - y)] = at(img, x, y);
  return out;
}

// 命名构造（避免 Uint8Array 误用）
function GrayImage2(w: number, h: number): GrayImage {
  return { width: w, height: h, data: new Uint8Array(w * h) };
}

export function blank(w: number, h: number, bg = 24): GrayImage {
  return { width: w, height: h, data: new Uint8Array(w * h).fill(bg) };
}

/** 在椭圆区域叠加高斯亮斑；clamp>threshold 即为饱和证据 */
export function paintBand(
  img: GrayImage,
  center: Point,
  rx: number,
  ry: number,
  intensity: number,
  opts: { saturate?: boolean; skew?: number; tailDown?: number } = {},
): { contour: Point[]; saturatedPixels: Point[] } {
  const contour = ellipseContour(center, rx, ry, 28, opts.skew ?? 0);
  const saturated: Point[] = [];
  for (let y = Math.floor(center.y - ry - (opts.tailDown ?? 0)); y <= center.y + ry; y++) {
    for (let x = Math.floor(center.x - rx - 2); x <= center.x + rx + 2; x++) {
      const dx = (x - center.x) / rx;
      let dy = (y - center.y) / ry;
      if (opts.tailDown && y > center.y) dy += (opts.tailDown * (y - center.y)) / (ry * 6);
      let v = intensity * Math.exp(-(dx * dx + dy * dy) * 2.2) + (Math.random() - 0.5) * 3;
      if (opts.saturate) v = Math.min(255, v * 1.25 + 35);
      const cur = at(img, x, y);
      if (cur + v > cur) setPx(img, x, y, cur + v);
      if (at(img, x, y) >= 250) saturated.push({ x, y });
    }
  }
  return { contour, saturatedPixels: saturated };
}

/** 列/行投影，用于自动检测泳道与拍摄方向 */
export function profile(img: GrayImage, axis: 'columns' | 'rows'): number[] {
  const n = axis === 'columns' ? img.width : img.height;
  const out = new Array<number>(n).fill(0);
  for (let y = 0; y < img.height; y++)
    for (let x = 0; x < img.width; x++) {
      const v = img.data[y * img.width + x]!;
      if (axis === 'columns') out[x]! += v;
      else out[y]! += v;
    }
  return out;
}

export function smooth(values: number[], window: number): number[] {
  const out: newArray(values.length);
  const half = Math.floor(window / 2);
  for (let i = 0; i < values.length; i++) {
    let s = 0, c = 0;
    for (let k = -half; k <= half; k++) {
      const j = i + k;
      if (j >= 0 && j < values.length) { s += values[j]!; c++; }
    }
    out[i] = s / c;
  }
  return out;
}
type newArray = number[];
