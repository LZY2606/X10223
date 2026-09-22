import { PNG } from 'pngjs';
import type { PixelPoint } from './types';
import { clamp } from './geometry';

/**
 * 合成原始凝胶图像（16-bit 语义，编码为 16-bit 灰度 PNG）。
 * 这是领域材料：加样孔在顶部，分子量越小迁移越远（y 越大）。
 * 生成器同时产出像素级真值（lane 曲线、条带中心、饱和区），用于离线案例包。
 */
export interface SynthBand {
  rankHint?: number;
  /** 沿 lane 中心线的迁移弧长 px */
  s: number;
  /** 相对峰宽（高斯 sigma, px） */
  sigma: number;
  intensity: number; // 0..1，>1 产生饱和平顶
  tail?: 'down' | 'none'; // 向下拖尾
}

export interface SynthLane {
  role: 'ladder' | 'sample';
  /** 中心线 x 随 y 的横向偏移函数（"微笑"用二次曲线） */
  bend?: (y: number) => number;
  bands: SynthBand[];
}

export interface SynthGelOptions {
  width: number;
  height: number;
  laneXs: number[];
  laneWidth: number;
  lanes: SynthLane[];
  /** 加样孔 y */
  originY?: number;
  /** 随机噪声振幅（确定性，传入 seed 可复现） */
  noise?: number;
  seed?: number;
  background?: number;
}

export interface SynthGelResult {
  pngBuffer: Buffer;
  width: number;
  height: number;
  centers: { laneIndex: number; center: PixelPoint; saturated: boolean }[][];
  centerlines: PixelPoint[][];
  laneBounds: { left: PixelPoint[]; right: PixelPoint[] }[];
  maxEncoded: number;
  saturatedPixels: PixelPoint[];
}

/** 确定性伪随机 */
function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function generateGel(opts: SynthGelOptions): SynthGelResult {
  const { width, height, laneXs, laneWidth, lanes } = opts;
  const originY = opts.originY ?? 24;
  const noiseAmp = opts.noise ?? 0.02;
  const rnd = mulberry32(opts.seed ?? 42);
  const bg = opts.background ?? 0.08;
  const MAX = 65535;

  const centerlines: PixelPoint[][] = laneXs.map((x0, laneIndex) => {
    const bend = lanes[laneIndex]?.bend;
    const pts: PixelPoint[] = [];
    for (let y = originY; y <= height - 12; y += 8) {
      pts.push({ x: x0 + (bend ? bend(y) : 0), y });
    }
    return pts;
  });

  const intensity = new Float64Array(width * height).fill(bg);
  const centers: { laneIndex: number; center: PixelPoint; saturated: boolean }[][] = lanes.map(() => []);
  const saturatedPixels: PixelPoint[] = [];

  lanes.forEach((lane, laneIndex) => {
    const line = centerlines[laneIndex]!;
    for (const band of lane.bands ?? []) {
      // 沿中心线弧长 -> 点
      const center = pointAtPolylineArc(line, band.s);
      let anySat = false;
      const sigma = band.sigma;
      const reach = Math.ceil(sigma * 3.2) + 4;
      for (let y = Math.max(0, Math.floor(center.y - reach)); y <= Math.min(height - 1, Math.ceil(center.y + reach)); y++) {
        for (let x = Math.max(0, Math.floor(center.x - reach)); x <= Math.min(width - 1, Math.ceil(center.x + reach)); x++) {
          const gy = Math.exp(-((x - center.x) ** 2) / (2 * (laneWidth / 4) ** 2));
          // 沿迁移方向；拖尾使向下一侧展宽
          const dy = y - center.y;
          const sy = dy > 0 && band.tail === 'down' ? sigma * 2.4 : sigma;
          const along = Math.exp(-(dy * dy) / (2 * sy * sy));
          const v = band.intensity * gy * along;
          const idx = y * width + x;
          intensity[idx] += v;
          if (bg + v >= 1.0) {
            anySat = true;
            if (saturatedPixels.length < 4000) saturatedPixels.push({ x, y });
          }
        }
      }
      centers[laneIndex]!.push({ laneIndex, center, saturated: anySat });
    }
  });

  const png = new PNG({ width, height, colorType: 0, bitDepth: 16 });
  for (let i = 0; i < width * height; i++) {
    const n = (rnd() - 0.5) * noiseAmp;
    const v = clamp(intensity[i]! + n, 0, 1);
    const g = Math.round(v * MAX);
    // 16-bit grayscale PNG: 每像素 2 字节，大端
    png.data[i * 2] = (g >> 8) & 0xff;
    png.data[i * 2 + 1] = g & 0xff;
  }

  const laneBounds = centerlines.map((line) => ({
    left: line.map((p) => ({ x: p.x - laneWidth / 2, y: p.y })),
    right: line.map((p) => ({ x: p.x + laneWidth / 2, y: p.y })),
  }));

  return {
    pngBuffer: PNG.sync.write(png, { colorType: 0, bitDepth: 16 }),
    width,
    height,
    centers,
    centerlines,
    laneBounds,
    maxEncoded: MAX,
    saturatedPixels,
  };
}

function pointAtPolylineArc(points: PixelPoint[], s: number): PixelPoint {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const seg = Math.hypot(points[i]!.x - points[i - 1]!.x, points[i]!.y - points[i - 1]!.y);
    if (acc + seg >= s) {
      const t = (s - acc) / seg;
      return {
        x: points[i - 1]!.x + (points[i]!.x - points[i - 1]!.x) * t,
        y: points[i - 1]!.y + (points[i]!.y - points[i - 1]!.y) * t,
      };
    }
    acc += seg;
  }
  return { ...points[points.length - 1]! };
}

/** 旋转 16-bit 灰度 PNG（最近邻），返回新缓冲与尺寸 */
export function rotateGrayPng(buffer: Buffer, deg: number): { buffer: Buffer; width: number; height: number } {
  const src = PNG.sync.read(buffer);
  const norm = ((Math.round(deg / 90) * 90) % 360 + 360) % 360;
  if (norm === 0) return { buffer, width: src.width, height: src.height };
  const swap = norm === 90 || norm === 270;
  const w2 = swap ? src.height : src.width;
  const h2 = swap ? src.width : src.height;
  const out = new PNG({ width: w2, height: h2, colorType: 0, bitDepth: 16 });
  const get = (x: number, y: number) => {
    const i = (y * src.width + x) * 2;
    return (src.data[i]! << 8) | src.data[i + 1]!;
  };
  for (let y = 0; y < h2; y++) {
    for (let x = 0; x < w2; x++) {
      let sx: number;
      let sy: number;
      if (norm === 90) {
        sx = x;
        sy = src.height - 1 - y;
      } else if (norm === 270) {
        sx = src.width - 1 - x;
        sy = y;
      } else {
        sx = src.width - 1 - x;
        sy = src.height - 1 - y;
      }
      const g = get(sx, sy);
      const i = (y * w2 + x) * 2;
      out.data[i] = (g >> 8) & 0xff;
      out.data[i + 1] = g & 0xff;
    }
  }
  return { buffer: PNG.sync.write(out, { colorType: 0, bitDepth: 16 }), width: w2, height: h2 };
}
