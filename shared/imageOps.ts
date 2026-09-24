/**
 * 图像栅格操作：旋转（90/180/270）、沿曲线采样、高斯条带合成。
 * 检测运行在 canonical 帧；旋转变体的候选必须能通过弧长基准与基线对齐。
 */
import type { Raster } from './png';

export function rotateRaster(src: Raster, deg: 0 | 90 | 180 | 270): Raster {
  if (deg === 0) return src;
  const ch = src.channels;
  if (deg === 180) {
    const out = new Uint8Array(src.data.length);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        for (let c = 0; c < ch; c++) {
          out[((src.height - 1 - y) * src.width + (src.width - 1 - x)) * ch + c] =
            src.data[(y * src.width + x) * ch + c]!;
        }
      }
    }
    return { width: src.width, height: src.height, channels: ch, data: out };
  }
  const w = deg === 90 ? src.height : src.height;
  const h = deg === 90 ? src.width : src.width;
  const out = new Uint8Array(w * h * ch);
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      let nx: number, ny: number;
      if (deg === 90) {
        nx = src.height - 1 - y;
        ny = x;
      } else {
        nx = y;
        ny = src.width - 1 - x;
      }
      for (let c = 0; c < ch; c++) {
        out[(ny * w + nx) * ch + c] = src.data[(y * src.width + x) * ch + c]!;
      }
    }
  }
  return { width: w, height: h, channels: ch, data: out };
}

export function setPixel(r: Raster, x: number, y: number, v: number[]): void {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  for (let c = 0; c < r.channels; c++) r.data[(y * r.width + x) * r.channels + c] = clamp(v[c] ?? v[0]!);
}

export function clamp(v: number): number {
  return v < 0 ? 0 : v > 255 ? 255 : v;
}

/** 反走样高斯斑点（饱和时削顶到 255）。 */
export function paintGaussian(
  r: Raster,
  cx: number,
  cy: number,
  sigmaX: number,
  sigmaY: number,
  amplitude: number,
  base = 8
): void {
  const rx = Math.ceil(sigmaX * 3);
  const ry = Math.ceil(sigmaY * 3);
  for (let y = Math.max(0, cy - ry); y <= Math.min(r.height - 1, cy + ry); y++) {
    for (let x = Math.max(0, cx - rx); x <= Math.min(r.width - 1, cx + rx); x++) {
      const g = amplitude * Math.exp(-((x - cx) ** 2 / (2 * sigmaX ** 2) + (y - cy) ** 2 / (2 * sigmaY ** 2)));
      for (let c = 0; c < r.channels; c++) {
        const idx = (y * r.width + x) * r.channels + c;
        r.data[idx] = clamp(Math.max(base, r.data[idx] ?? 0) + g * 0.85);
      }
    }
  }
}

/** 沿曲线周围取平均得到一维强度轮廓（迁移方向弧长 -> 强度）。 */
export function sampleProfile(
  gray: Uint8Array,
  width: number,
  height: number,
  curve: { x: number; y: number }[],
  halfWidth: number,
  stepPx = 1
): { s: number[]; intensity: number[] } {
  const sOut: number[] = [];
  const out: number[] = [];
  let totalLen = 0;
  for (let i = 1; i < curve.length; i++) {
    totalLen += Math.hypot(curve[i]!.x - curve[i - 1]!.x, curve[i]!.y - curve[i - 1]!.y);
  }
  for (let s = 0; s <= totalLen; s += stepPx) {
    const p = pointAt(curve, s);
    let acc = 0;
    let n = 0;
    for (const t of curve) {
      void t;
    }
    const next = pointAt(curve, Math.min(totalLen, s + 1));
    const dx = next.x - p.x;
    const dy = next.y - p.y;
    const dl = Math.hypot(dx, dy) || 1;
    const nx = -dy / dl;
    const ny = dx / dl;
    for (let off = -halfWidth; off <= halfWidth; off++) {
      const x = Math.round(p.x + nx * off);
      const y = Math.round(p.y + ny * off);
      if (x >= 0 && y >= 0 && x < width && y < height) {
        acc += gray[y * width + x]!;
        n++;
      }
    }
    sOut.push(s);
    out.push(n ? acc / n : 0);
  }
  return { s: sOut, intensity: out };
}

function pointAt(curve: { x: number; y: number }[], targetS: number): { x: number; y: number } {
  let acc = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i]!;
    const b = curve[i + 1]!;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + segLen >= targetS) {
      const t = (targetS - acc) / (segLen || 1);
      return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    }
    acc += segLen;
  }
  return curve[curve.length - 1]!;
}
