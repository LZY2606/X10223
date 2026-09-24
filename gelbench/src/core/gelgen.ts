import type { PixelPoint } from "./types.js";
import { encodePng, type GrayImage, maxValue } from "./png.js";

// ---------------------------------------------------------------------------
// 合成凝胶图生成器（领域素材，不是通用表格）：
// 亮带 = 暗背景上的高斯亮点；泳道可弯曲（微笑）；带可饱和/拖尾/重叠/缺失。
// 坐标约定：加样端在顶部，迁移向下，source_px。
// ---------------------------------------------------------------------------

export interface GenBand {
  /** 沿脊线的迁移距离 s（px 自加样端） */
  s: number;
  amp: number; // 峰值强度（截断前）
  sigmaS?: number; // 沿迁移方向
  sigmaX?: number; // 沿泳道宽度方向
  saturated?: boolean; // 截断到 max，形成平台
  tail?: { length: number; decay: number }; // 向远端(迁移方向)拖尾
}

export interface GelSpec {
  width?: number;
  height?: number;
  bitDepth?: 8 | 16;
  laneX: number[]; // 各泳道加样端 x
  top: number;
  bottom: number;
  /** 弯曲幅度：中心泳道比两侧迁移更远（微笑效应）。 */
  smileAmp?: number;
  /** 蛇形幅度（x 随 s 摆动） */
  wiggleAmp?: number;
  wigglePeriods?: number;
  bands: GenBand[][]; // 每泳道的带
  seedNoise?: number;
}

export function laneCenterX(g: GelSpec, laneIdx: number): number {
  return g.laneX[laneIdx]!;
}

/** 泳道脊线控制点（source_px），等 s 步长采样，包含微笑+蛇形。 */
export function laneSpinePoints(g: GelSpec, laneIdx: number, samples = 31): PixelPoint[] {
  const width = g.width ?? 420;
  const n = g.laneX.length;
  const norm = n === 1 ? 0 : laneIdx / (n - 1) - 0.5; // -0.5..0.5
  const smile = g.smileAmp ?? 0;
  const wiggle = g.wiggleAmp ?? 0;
  const periods = g.wigglePeriods ?? 1.5;
  const pts: PixelPoint[] = [];
  for (let i = 0; i < samples; i++) {
    const t = i / (samples - 1);
    const s = g.top + t * (g.bottom - g.top);
    // 微笑：中心泳道(t norm≈0)迁移更远 -> 弧长相同但 y 更大
    const y = s + smile * 4 * norm * norm * Math.sin(Math.PI * t);
    const x = g.laneX[laneIdx]! + wiggle * Math.sin(2 * Math.PI * periods * t + laneIdx * 0.7);
    pts.push({ x, y });
  }
  void width;
  return pts;
}

export function generateGel(spec: GelSpec): GrayImage {
  const width = spec.width ?? 420;
  const height = spec.height ?? 340;
  const bitDepth = spec.bitDepth ?? 16;
  const max = maxValue(bitDepth);
  const base = Math.round(max * 0.05);
  const noiseAmp = spec.seedNoise ?? Math.round(max * 0.008);
  const data = new Uint16Array(width * height);
  // 确定性伪随机噪声
  let seed = 1234;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff - 0.5;
  };
  for (let i = 0; i < data.length; i++) data[i] = Math.max(0, base + Math.round(rand() * noiseAmp));

  const spines = spec.laneX.map((_, li) => {
    const pts = laneSpinePoints(spec, li);
    const cum = [0];
    for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1]! + Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y));
    return { pts, cum, length: cum[cum.length - 1]! };
  });

  const splat = (x: number, y: number, amp: number, sx: number, sy: number) => {
    const r = Math.ceil(3.2 * Math.max(sx, sy));
    const x0 = Math.max(0, Math.floor(x - r));
    const x1 = Math.min(width - 1, Math.ceil(x + r));
    const y0 = Math.max(0, Math.floor(y - r));
    const y1 = Math.min(height - 1, Math.ceil(y + r));
    for (let yy = y0; yy <= y1; yy++) {
      for (let xx = x0; xx <= x1; xx++) {
        const dx = xx - x;
        const dy = yy - y;
        const g = amp * Math.exp(-(dx * dx / (2 * sx * sx) + dy * dy / (2 * sy * sy)));
        const idx = yy * width + xx;
        data[idx] = Math.min(max, data[idx]! + g);
      }
    }
  };

  spec.bands.forEach((bands, li) => {
    const spine = spines[li]!;
    const at = (s: number) => {
      for (let i = 1; i < spine.cum.length; i++) {
        if (s <= spine.cum[i]! || i === spine.cum.length - 1) {
          const t = (s - spine.cum[i - 1]!) / (spine.cum[i]! - spine.cum[i - 1]! || 1);
          const a = spine.pts[i - 1]!;
          const b = spine.pts[i]!;
          return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
        }
      }
      return spine.pts[spine.pts.length - 1]!;
    };
    for (const band of bands) {
      const p = at(band.s);
      let amp = band.amp;
      if (band.saturated) amp = max; // 平台饱和
      const sy = band.sigmaS ?? 4.2;
      const sx = band.sigmaX ?? 7.5;
      splat(p.x, p.y, amp, sx, sy);
      if (band.tail) {
        // 拖尾：沿迁移方向逐段衰减的额外高斯
        const steps = Math.max(1, Math.round(band.tail.length / 2));
        for (let k = 1; k <= steps; k++) {
          const ds = (band.tail.length * k) / steps;
          const q = at(band.s + ds);
          splat(q.x, q.y, amp * Math.exp(-band.tail.decay * ds), sx, sy * 1.4);
        }
      }
    }
  });

  // 再次截断（重叠叠加也可能触顶）
  for (let i = 0; i < data.length; i++) data[i] = Math.min(max, Math.round(data[i]!));
  return { width, height, bitDepth, data };
}

export function gelPng(spec: GelSpec): Buffer {
  return encodePng(generateGel(spec));
}
