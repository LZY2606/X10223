import type { BandFlag, PixelPoint, Unit } from '@shared/types.js';
import { Image8, encodePng } from './image.js';

/** 确定性 PRNG，保证案例包可重放。 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export interface SynthBand {
  key: string;
  /** 校正迁移基准位置（胶顶向下像素，未加微笑偏移）。 */
  baseT: number;
  peak: number; // 峰值亮度（>250 会被截断形成饱和平台）
  sigmaX: number;
  sigmaY: number;
  saturated?: boolean;
  trailing?: boolean;
  /** 重叠配对：与同 lane 另一带共享 overlapKey，中心由 baseT 偏移生成。 */
  overlapWith?: string;
  overlapGap?: number;
}

export interface SynthLane {
  laneId: string;
  role: 'ladder' | 'sample' | 'empty';
  sampleName?: string;
  bands: SynthBand[];
  /** 该泳道不渲染（缺道）。 */
  absent?: boolean;
}

export interface GelSpec {
  width: number;
  height: number;
  /** 泳道中心 x（直线情形）。 */
  laneCenters: number[];
  laneHalfWidth: number;
  /** 泳道横向弯曲系数：x(t)=cx+bend*(t-midY)^2。 */
  bend: number;
  /** 微笑迁移曲率：t_actual=baseT+k*(cx-xRef)^2。 */
  smileK: number;
  smileRefX: number;
  lanes: SynthLane[];
  seed: number;
  background?: number;
}

export interface RenderedGel {
  png: Uint8Array;
  image: Image8;
  /** 渲染真值：每条带中心（canonical 像素）。 */
  truth: { laneId: string; key: string; x: number; t: number; flags: BandFlag[] }[];
}

function paintGaussian(
  img: Image8,
  cx: number,
  cy: number,
  sx: number,
  sy: number,
  peak: number,
  rng: () => number,
): void {
  const rx = Math.ceil(3 * sx);
  const ry = Math.ceil(3 * sy);
  for (let y = Math.max(0, Math.floor(cy - ry)); y < Math.min(img.height, Math.ceil(cy + ry + 1)); y++) {
    for (let x = Math.max(0, Math.floor(cx - rx)); x < Math.min(img.width, Math.ceil(cx + rx + 1)); x++) {
      const gx = Math.exp(-((x - cx) ** 2) / (2 * sx * sx));
      const gy = Math.exp(-((y - cy) ** 2) / (2 * sy * sy));
      const add = peak * gx * gy;
      if (add < 0.5) continue;
      const idx = y * img.width + x;
      const noise = (rng() - 0.5) * 6;
      img.gray[idx] = Math.min(255, Math.max(0, Math.round(img.gray[idx] + add + noise)));
    }
  }
}

export function renderGel(spec: GelSpec): RenderedGel {
  const rng = mulberry32(spec.seed);
  const bg = spec.background ?? 28;
  const img: Image8 = {
    width: spec.width,
    height: spec.height,
    gray: new Uint8Array(spec.width * spec.height),
  };
  for (let i = 0; i < img.gray.length; i++) {
    img.gray[i] = Math.max(0, Math.min(255, bg + (rng() - 0.5) * 7));
  }

  const midY = spec.height / 2;
  const centerXAt = (laneIndex: number, t: number): number =>
    spec.laneCenters[laneIndex] + spec.bend * (t - midY) ** 2;

  // 微弱泳道底色（弯曲泳道可见，检测器据此逐行跟踪）。
  spec.lanes.forEach((lane, li) => {
    if (lane.absent) return;
    for (let t = 0; t < spec.height; t++) {
      const cx = centerXAt(li, t);
      for (let dx = -spec.laneHalfWidth; dx <= spec.laneHalfWidth; dx++) {
        const x = Math.round(cx + dx);
        if (x < 0 || x >= spec.width) continue;
        const idx = t * spec.width + x;
        img.gray[idx] = Math.min(255, img.gray[idx] + 12 + (rng() - 0.5) * 4);
      }
    }
  });

  const truth: RenderedGel['truth'] = [];
  spec.lanes.forEach((lane, li) => {
    if (lane.absent) return;
    const cxLane = spec.laneCenters[li];
    const smileOffset = spec.smileK * (cxLane - spec.smileRefX) ** 2;
    for (const band of lane.bands) {
      let t = band.baseT + smileOffset;
      let key = band.key;
      const renderOne = (bt: number, peak: number, sy: number, k: string, extra: BandFlag[]): void => {
        const x = centerXAt(li, bt);
        paintGaussian(img, x, bt, band.sigmaX, sy, peak, rng);
        if (band.trailing) {
          // 向下拖尾：拉长的弱尾
          paintGaussian(img, x, bt + sy * 1.6, band.sigmaX, sy * 1.9, peak * 0.35, rng);
        }
        const flags: BandFlag[] = [...extra];
        if (band.saturated) flags.push('saturated');
        if (band.trailing) flags.push('trailing');
        truth.push({ laneId: lane.laneId, key: k, x, t: bt, flags: Array.from(new Set(flags)) });
      };
      if (band.overlapWith) {
        const gap = band.overlapGap ?? 8;
        renderOne(t, band.peak, band.sigmaY, band.key, ['overlap', 'broad']);
        renderOne(t + gap, band.peak * 0.95, band.sigmaY, band.key + '+pair', ['overlap', 'broad']);
      } else {
        renderOne(t, band.peak, band.sigmaY, band.key, []);
      }
    }
  });

  return { png: encodePng(img), image: img, truth };
}

/** 标准 ladder 标称（bp），迁移由胶顶至胶底指数递减。 */
export function dnaLadderNominal(): { nominalId: string; bp: number }[] {
  return [
    { nominalId: 'n1000', bp: 1000 },
    { nominalId: 'n850', bp: 850 },
    { nominalId: 'n650', bp: 650 },
    { nominalId: 'n500', bp: 500 },
    { nominalId: 'n400', bp: 400 },
    { nominalId: 'n300', bp: 300 },
    { nominalId: 'n200', bp: 200 },
  ];
}

/** 按 log-linear 关系生成 ladder 基准迁移 t。 */
export function ladderBaseTs(bpValues: number[], tTop: number, tBottom: number): number[] {
  const logs = bpValues.map((v) => Math.log(v));
  const max = Math.max(...logs);
  const min = Math.min(...logs);
  return logs.map((l) => tTop + ((max - l) / (max - min)) * (tBottom - tTop));
}

export function unitName(unit: Unit): string {
  return unit === 'bp' ? 'bp' : unit === 'nt' ? 'nt' : 'kDa';
}

export type { PixelPoint };
