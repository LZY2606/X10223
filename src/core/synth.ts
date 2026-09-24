import { createRaster, encodePng, type GrayRaster } from './png';

/** 确定性伪随机（固定种子 => 案例包可复现） */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthBand {
  /** 沿泳道的归一化位置 0..1（胶顶->胶底） */
  rf: number;
  intensity: number;      // 峰值 0..1，>=0.98 视为饱和
  widthPx: number;        // 横向半宽
  heightPx: number;       // 纵向半高
  trailing?: boolean;     // 拖尾
}

export interface SynthLane {
  x0: number;             // 胶顶处中心 x
  curvature: number;      // 微笑弯曲：x 随 (归一化y)^2 的偏移像素
  bands: SynthBand[];
}

export interface SynthSpec {
  width: number;
  height: number;
  yTop: number;
  yBottom: number;
  lanes: SynthLane[];
  backgroundNoise: number;
  seed: number;
}

/** 泳道中心曲线：x(y) = x0 + curvature * t^2，t 为归一化纵向位置（微笑形） */
export function laneCurveX(lane: Pick<SynthLane, 'x0' | 'curvature'>, t: number): number {
  return lane.x0 + lane.curvature * t * t;
}

/** 确定性合成一张凝胶灰度图。 */
export function synthGel(spec: SynthSpec): GrayRaster {
  const r = createRaster(spec.width, spec.height, 8);
  const rand = mulberry32(spec.seed);
  const noise = new Float64Array(spec.width * spec.height);
  for (let i = 0; i < noise.length; i++) noise[i] = rand() * spec.backgroundNoise;

  const span = spec.yBottom - spec.yTop;
  for (const lane of spec.lanes) {
    for (const band of lane.bands) {
      const cy = spec.yTop + band.rf * span;
      const cx = laneCurveX(lane, band.rf);
      const sx = band.widthPx, sy = band.heightPx;
      const x0 = Math.max(0, Math.floor(cx - 4 * sx)), x1 = Math.min(spec.width - 1, Math.ceil(cx + 4 * sx));
      const y0 = Math.max(0, Math.floor(cy - 4 * sy)), y1 = Math.min(spec.height - 1, Math.ceil(cy + 4 * sy));
      const tail = band.trailing ? band.heightPx * 6 : 0;
      const y1t = Math.min(spec.height - 1, Math.ceil(cy + tail + 4 * sy));
      for (let y = y0; y <= y1t; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x - cx) / sx, dy = (y - cy) / sy;
          let v = Math.exp(-(dx * dx + dy * dy) / 2);
          if (band.trailing && y > cy) {
            v = Math.max(v, Math.exp(-(dx * dx) / 2) * Math.exp(-(y - cy) / (tail / 2)) * 0.6);
          }
          const idx = y * spec.width + x;
          const cur = r.data[idx] / 255;
          const next = 1 - (1 - cur) * (1 - v * band.intensity);
          r.data[idx] = Math.min(255, Math.round(next * 255));
        }
      }
    }
  }
  for (let i = 0; i < noise.length; i++) {
    r.data[i] = Math.min(255, Math.max(0, Math.round(r.data[i] + noise[i])));
  }
  return r;
}

export function synthGelPng(spec: SynthSpec): Buffer {
  return encodePng(synthGel(spec));
}
