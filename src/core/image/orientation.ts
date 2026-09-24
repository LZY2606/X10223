import { toGray } from './png';
import type { OrientedImage, RawImage } from './types';
import { sha256Hex } from '../ids';
import type { OrientationMaterial } from '../types';

// 将原图按拍摄方向材料定向。像素级坐标一律标注 frame。
export function orientImage(img: RawImage, o: OrientationMaterial): OrientedImage {
  let g = toGray(img);
  let w = img.width;
  let h = img.height;
  if (o.flipH) g = flipHorizontal(g, w, h);
  const r = o.rotationCw;
  if (r === 0) return pack(g, w, h, o, sha256Hex(img.data));
  if (r === 180) return pack(rot180(g, w, h), w, h, o, sha256Hex(img.data));
  const rotated = r === 90 ? rot90Cw(g, w, h) : rot90Ccw(g, w, h);
  return pack(rotated, h, w, o, sha256Hex(img.data));
}

function pack(gray: Buffer, w: number, h: number, o: OrientationMaterial, parentSha: string): OrientedImage {
  return { width: w, height: h, channels: 1, data: gray, rotationCw: o.rotationCw, flipH: o.flipH, parentSha256: parentSha };
}

function flipHorizontal(g: Buffer, w: number, h: number): Buffer {
  const out = Buffer.alloc(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) out[y * w + (w - 1 - x)] = g[y * w + x];
  }
  return out;
}

function rot180(g: Buffer, w: number, h: number): Buffer {
  const out = Buffer.alloc(g.length);
  for (let i = 0; i < g.length; i++) out[g.length - 1 - i] = g[i];
  return out;
}

// 顺时针 90：dst(x', y') = src(w-1-y', x')
function rot90Cw(g: Buffer, w: number, h: number): Buffer {
  const out = Buffer.alloc(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = h - 1 - y;
      const ny = x;
      out[ny * h + nx] = g[y * w + x];
    }
  }
  return out;
}

function rot90Ccw(g: Buffer, w: number, h: number): Buffer {
  const out = Buffer.alloc(g.length);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = y;
      const ny = w - 1 - x;
      out[ny * h + nx] = g[y * w + x];
    }
  }
  return out;
}

// 定向图 -> 原图像素坐标（保留像素级来源的回链）
export function orientedToRaw(
  p: { x: number; y: number },
  o: OrientationMaterial,
  rawW: number,
  rawH: number
): { x: number; y: number } {
  let { x, y } = p;
  const r = o.rotationCw;
  if (r === 90) { // 逆变换
    const t = x; x = y; y = rawW - 1 - t;
  } else if (r === 180) {
    x = (r === 180 ? rawW : rawH) - 1 - x;
    y = rawH - 1 - y;
  } else if (r === 270) {
    const t = y; y = x; x = rawH - 1 - t;
  }
  if (o.flipH) {
    const w = r === 90 || r === 270 ? rawH : rawW;
    x = w - 1 - x;
  }
  return { x, y };
}
