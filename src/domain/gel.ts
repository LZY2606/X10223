import type { XY } from "./types.js";
import type { Raster } from "./png.js";

export interface GenBand {
  s: number;
  amplitude: number;
  sigma: number;
  tail?: number;
  plateau?: boolean;
}

export interface GelSpec {
  width: number;
  height: number;
  laneXs: number[];
  /** 微笑强度：边缘泳道中点相对直线的纵向偏移（像素），中心泳道为 0 */
  smile: number;
  /** 横向摆动幅度 */
  wander: number;
  topMargin: number;
  bottomMargin: number;
  background: number;
  noise: number;
  bands: Record<number, GenBand[]>; // lane ordinal -> bands
}

export interface CurveTruth {
  ordinal: number;
  baseX: number;
  points: XY[];
  halfWidth: number;
}

export interface GelTruth {
  raster: Raster;
  curves: CurveTruth[];
}

/** 泳道曲线参数化：t∈[0,1]；微笑使边缘泳道 s↔y 关系与中心泳道不同 */
function lanePoint(
  spec: GelSpec,
  ordinal: number,
  baseX: number,
  t: number
): XY {
  const center = (spec.laneXs.length - 1) / 2;
  const rel = ordinal - center;
  const sign = rel === 0 ? 0 : rel < 0 ? -1 : 1;
  const strength = center === 0 ? 0 : Math.abs(rel) / center;
  const y =
    spec.topMargin +
    t * (spec.height - spec.topMargin - spec.bottomMargin) +
    spec.smile * 4 * t * (1 - t) * sign * strength;
  const x =
    baseX +
    spec.wander *
      strength *
      Math.sin(2 * Math.PI * t + ordinal * 1.7);
  return { x, y };
}

export function makeGel(spec: GelSpec): GelTruth {
  const pixels = new Float32Array(spec.width * spec.height);
  pixels.fill(spec.background);
  const step = 0.5;
  const H = spec.height - spec.topMargin - spec.bottomMargin;
  const total = H + Math.abs(spec.smile) * 0.5 + 8;
  const n = Math.round(total / step);

  const curves: CurveTruth[] = spec.laneXs.map((baseX, ordinal) => {
    const pts: XY[] = [];
    for (let i = 0; i <= n; i++) {
      pts.push(lanePoint(spec, ordinal, baseX, Math.min(1, i / n)));
    }
    return { ordinal, baseX, points: pts, halfWidth: 7 };
  });

  for (let ordinal = 0; ordinal < curves.length; ordinal++) {
    const bands = spec.bands[ordinal] ?? [];
    if (bands.length === 0) continue;
    const curve = curves[ordinal].points;
    for (const band of bands) {
      const sigmaW = 6;
      for (let i = 0; i <= n; i++) {
        const s = i * step;
        const center = curve[i];
        let g = Math.exp(-((s - band.s) ** 2) / (2 * band.sigma ** 2));
        if (band.tail && s > band.s) {
          g +=
            (band.tail === 0 ? 0 : 0.55) *
            Math.exp(-(s - band.s) / (band.tail * 1.7)) *
            Math.exp(-((s - band.s) ** 2) / (2 * (band.sigma * 2.4) ** 2));
        }
        if (g < 0.004) continue;
        for (let w = -10; w <= 10; w++) {
          const gw = Math.exp(-(w * w) / (2 * sigmaW * sigmaW));
          const x = Math.round(center.x + w);
          const y = Math.round(center.y);
          if (x < 0 || y < 0 || x >= spec.width || y >= spec.height) continue;
          let add = band.amplitude * g * gw;
          if (band.plateau) add = Math.min(add, band.amplitude);
          pixels[y * spec.width + x] += add;
        }
      }
    }
  }

  let seed = 1337;
  const rand = (): number => {
    seed = (seed * 1664525 + 1013904223) % 4294967296;
    return seed / 4294967296;
  };
  const out = new Uint8Array(spec.width * spec.height);
  for (let i = 0; i < out.length; i++) {
    const nse = (rand() - 0.5) * spec.noise;
    out[i] = Math.min(255, Math.max(0, Math.round(pixels[i] + nse)));
  }
  return {
    raster: { width: spec.width, height: spec.height, pixels: out },
    curves
  };
}

/** 90° 顺时针旋转（像素级变换，用于“旋转图像”场景） */
export function rotate90CW(raster: Raster): Raster {
  const { width, height, pixels } = raster;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      out[x * height + (height - 1 - y)] = pixels[y * width + x];
    }
  }
  return { width: height, height: width, pixels: out };
}
