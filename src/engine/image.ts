import { PNG } from 'pngjs';
import type { PixelPoint } from '@shared/types.js';

/** 8 位灰度图（canonical：泳道竖直、迁移向下）。 */
export interface Image8 {
  width: number;
  height: number;
  gray: Uint8Array; // length = width*height
}

export function decodePng(bytes: Uint8Array): Image8 {
  let png: PNG;
  try {
    png = PNG.sync.parse(Buffer.from(bytes));
  } catch (e) {
    throw new Error(`PNG 解析失败: ${(e as Error).message}`);
  }
  const { width, height, data } = png;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4];
    const g = data[i * 4 + 1];
    const b = data[i * 4 + 2];
    // ITU-R BT.601
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { width, height, gray };
}

export function encodePng(img: Image8): Uint8Array {
  const png = new PNG({ width: img.width, height: img.height });
  for (let i = 0; i < img.gray.length; i++) {
    const v = img.gray[i];
    png.data[i * 4] = v;
    png.data[i * 4 + 1] = v;
    png.data[i * 4 + 2] = v;
    png.data[i * 4 + 3] = 255;
  }
  return PNG.sync.write(png);
}

/**
 * 旋转到 canonical。angle 表示原图相对 canonical 的方向；
 * 即把原图“逆向旋转 angle”得到 canonical。统一约定：canonical 泳道竖直向下。
 */
export function rotateToCanonical(img: Image8, angleDeg: 0 | 90 | 180 | 270): Image8 {
  if (angleDeg === 0) return img;
  if (angleDeg === 180) return rotate180(img);
  if (angleDeg === 90) return rotateCw(img, 270); // 原图相对 canonical +90 -> 逆时针回正
  return rotateCw(img, 90); // angle=270
}

export function rotateCw(img: Image8, times: number): Image8 {
  let cur = img;
  const n = ((times % 4) + 4) % 4;
  for (let s = 0; s < n; s++) {
    const w = cur.height;
    const h = cur.width;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < cur.height; y++) {
      for (let x = 0; x < cur.width; x++) {
        const nx = cur.height - 1 - y;
        const ny = x;
        out[ny * w + nx] = cur.gray[y * cur.width + x];
      }
    }
    cur = { width: w, height: h, gray: out };
  }
  return cur;
}

function rotate180(img: Image8): Image8 {
  const out = new Uint8Array(img.gray.length);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      out[(img.height - 1 - y) * img.width + (img.width - 1 - x)] = img.gray[y * img.width + x];
    }
  }
  return { width: img.width, height: img.height, gray: out };
}

/** 双线性采样（canonical 坐标）。 */
export function sample(img: Image8, x: number, y: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const dx = x - x0;
  const dy = y - y0;
  const at = (xx: number, yy: number): number => {
    if (xx < 0 || yy < 0 || xx >= img.width || yy >= img.height) return 0;
    return img.gray[yy * img.width + xx];
  };
  const a = at(x0, y0);
  const b = at(x0 + 1, y0);
  const c = at(x0, y0 + 1);
  const d = at(x0 + 1, y0 + 1);
  return a * (1 - dx) * (1 - dy) + b * dx * (1 - dy) + c * (1 - dx) * dy + d * dx * dy;
}

/**
 * 沿中心线折线按固定步长采样。
 * 折线按 (x(t), y=t) 给出（弯曲泳道）；直线时 x(t) 恒定。
 * 返回纵向参数 t（像素，自顶部）与采样强度。
 */
export function sampleCenterline(
  img: Image8,
  xs: (t: number) => number,
  t0: number,
  t1: number,
  step = 1,
): { t: number; x: number; y: number; intensity: number }[] {
  const out: { t: number; x: number; y: number; intensity: number }[] = [];
  for (let t = t0; t <= t1; t += step) {
    const x = xs(t);
    out.push({ t, x, y: t, intensity: sample(img, x, t) });
  }
  return out;
}

export function interpolatePolyline(points: PixelPoint[]): (t: number) => number {
  const sorted = [...points].sort((a, b) => a.y - b.y);
  return (t: number) => {
    if (t <= sorted[0].y) return sorted[0].x;
    if (t >= sorted[sorted.length - 1].y) return sorted[sorted.length - 1].x;
    for (let i = 0; i < sorted.length - 1; i++) {
      const p = sorted[i];
      const q = sorted[i + 1];
      if (t >= p.y && t <= q.y) {
        const f = (t - p.y) / (q.y - p.y || 1);
        return p.x + (q.x - p.x) * f;
      }
    }
    return sorted[sorted.length - 1].x;
  };
}
