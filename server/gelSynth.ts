import { encodeGrayPng } from './png';
import type { PixelPoint } from '../shared/types';

// ---------- 领域合成规格：电泳凝胶图像 ----------
export interface SynthBand {
  y: number;           // 名义中心 y（未加微笑位移）
  amplitude: number;   // 0..1+
  width: number;       // 高斯 sigma (px)
  tailing?: boolean;   // 拖尾：下行方向展宽
}

export interface SynthLane {
  id: string;
  x: number;           // 泳道中心 x
  width: number;       // 泳道宽
  bands: SynthBand[];
}

export interface GelSpec {
  width: number;
  height: number;
  seed: number;
  rotationDeg: number;     // 拍摄旋转
  smileAmplitude: number;  // “微笑”弯曲幅度 (px)，中间泳道迁移更远
  background: number;
  noise: number;
  saturation: number;      // 强度截断（饱和）
  front: { y: number; amplitude: number; width: number }; // 染料前沿
  lanes: SynthLane[];
}

export interface GelImage {
  width: number;
  height: number;
  field: Float32Array;     // 0..1 强度
  spec: GelSpec;
}

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// “微笑”位移：同一分子量在不同 x 处迁移距离不同
export function smileShift(spec: GelSpec, x: number): number {
  const cx = spec.width / 2;
  const half = spec.width / 2;
  const u = (x - cx) / half;
  return spec.smileAmplitude * (1 - u * u);
}

export function synthesizeGel(spec: GelSpec): GelImage {
  const { width, height } = spec;
  const field = new Float32Array(width * height);
  const rand = mulberry32(spec.seed);
  const rad = (spec.rotationDeg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const cx = width / 2;
  const cy = height / 2;

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      // 逆旋转到源坐标
      const dx = x - cx;
      const dy = y - cy;
      const sx = cos * dx + sin * dy + cx;
      const sy = -sin * dx + cos * dy + cy;
      let v = spec.background + (rand() - 0.5) * spec.noise;
      if (sx >= 0 && sx < width && sy >= 0 && sy < height) {
        const shift = smileShift(spec, sx);
        for (const lane of spec.lanes) {
          const lx = (sx - lane.x) / (lane.width / 2.5);
          const laneProfile = Math.exp(-lx * lx);
          if (laneProfile < 0.01) continue;
          for (const band of lane.bands) {
            const by = band.y + shift;
            const d = sy - by;
            // 拖尾：下侧 sigma 随距离增大
            const sigma = band.tailing && d > 0 ? band.width * (1 + 0.18 * d) : band.width;
            const g = Math.exp(-(d * d) / (2 * sigma * sigma));
            v += band.amplitude * laneProfile * g;
          }
          // 染料前沿（同样受微笑位移影响）
          const fy = spec.front.y + shift;
          const fd = sy - fy;
          v += spec.front.amplitude * laneProfile * Math.exp(-(fd * fd) / (2 * spec.front.width * spec.front.width));
        }
      }
      field[y * width + x] = Math.min(Math.max(v, 0), spec.saturation);
    }
  }
  return { width, height, field, spec };
}

export function renderPng(image: GelImage): Buffer {
  const gray = new Uint8Array(image.width * image.height);
  for (let i = 0; i < gray.length; i++) {
    gray[i] = Math.round(Math.min(Math.max(image.field[i]!, 0), 1) * 255);
  }
  return encodeGrayPng(image.width, image.height, gray);
}

// 沿折线双线性采样强度（泳道中线轮廓）
export function sampleProfile(image: GelImage, points: PixelPoint[]): number[] {
  const { width, height, field } = image;
  return points.map((p) => {
    const x0 = Math.floor(p.x);
    const y0 = Math.floor(p.y);
    const fx = p.x - x0;
    const fy = p.y - y0;
    const at = (xx: number, yy: number) =>
      xx >= 0 && xx < width && yy >= 0 && yy < height ? field[yy * width + xx]! : 0;
    return (
      at(x0, y0) * (1 - fx) * (1 - fy) +
      at(x0 + 1, y0) * fx * (1 - fy) +
      at(x0, y0 + 1) * (1 - fx) * fy +
      at(x0 + 1, y0 + 1) * fx * fy
    );
  });
}
