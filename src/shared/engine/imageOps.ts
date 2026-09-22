// 图像派生：解码、吸光度、拍摄方向变换。保持 image_px 与 oriented_px 两坐标基准。
import { orientedDimensions } from '../geometry.js';

export interface OrientedGray {
  width: number;
  height: number;
  gray: Uint8Array; // oriented_px 行优先
  deg: number;
  originalWidth: number;
  originalHeight: number;
}

export function toAbsorbance(gray: Uint8Array): Float32Array {
  // 吸光度近似：1 - 灰度/255（带越暗值越大）
  const out = new Float32Array(gray.length);
  for (let i = 0; i < gray.length; i++) out[i] = 1 - gray[i]! / 255;
  return out;
}

export function rotateGrayMatrix(
  gray: Uint8Array,
  w: number,
  h: number,
  deg: number,
): { gray: Uint8Array; width: number; height: number } {
  const r = ((deg % 360) + 360) % 360;
  if (r === 0) return { gray, width: w, height: h };
  const swap = r === 90 || r === 270;
  const w2 = swap ? h : w;
  const h2 = swap ? w : h;
  const out = new Uint8Array(w2 * h2).fill(255);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx: number;
      let ny: number;
      if (r === 90) {
        nx = h - 1 - y;
        ny = x;
      } else if (r === 180) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      out[ny * w2 + nx] = gray[y * w + x]!;
    }
  }
  return { gray: out, width: w2, height: h2 };
}

export function orientImage(
  gray: Uint8Array,
  w: number,
  h: number,
  deg: number,
): OrientedGray {
  const r = ((deg % 360) + 360) % 360;
  if (r === 0) {
    return { width: w, height: h, gray, deg: r, originalWidth: w, originalHeight: h };
  }
  const t = rotateGrayMatrix(gray, w, h, r);
  return {
    width: t.width,
    height: t.height,
    gray: t.gray,
    deg: r,
    originalWidth: w,
    originalHeight: h,
  };
}

export { orientedDimensions };
