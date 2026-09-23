import { encodePngGray, type GrayImage } from './png.js';

/**
 * 离线凝胶图像生成器（领域材料）。
 * 生成黑底亮带的 8 位灰度电泳图，并刻意支持反例所需结构：
 * 旋转、微笑弯曲、ladder 缺带、饱和、重叠、拖尾。
 */

export interface GenBand {
  /** 迁移位置（沿 lane 中心线的 v，像素） */
  v: number;
  /** 峰值强度 0..1（>1 会被钳制，形成饱和平台） */
  amp: number;
  /** 沿迁移方向的标准差（像素） */
  sigmaV: number;
  /** 横向半宽（像素） */
  halfWidth: number;
  tail?: 'down' | 'up';
  tailLen?: number;
}

export interface GenLane {
  laneId: string;
  /** 中心线 u(v)：可弯曲（微笑）。v 为像素行。 */
  centerU: (v: number) => number;
  halfWidth: number;
  bands: GenBand[];
}

export interface GelSpec {
  width: number;
  height: number;
  background?: number;
  noise?: number;
  lanes: GenLane[];
  /** 饱和电平（0..1），超过即钳制为平台（饱和区）。 */
  saturationLevel?: number;
}

export interface RenderedGel {
  png: Buffer;
  width: number;
  height: number;
  /** 未钳制强度（0..1），供生成器侧自检与饱和区域标注。 */
  float: Float32Array;
  saturationMask: Uint8Array;
}

export function renderGel(spec: GelSpec): RenderedGel {
  const { width, height } = spec;
  const bg = spec.background ?? 0.05;
  const noise = spec.noise ?? 0.015;
  const sat = spec.saturationLevel ?? 1;
  const f = new Float32Array(width * height).fill(bg);

  for (let y = 0; y < height; y++) {
    for (const lane of spec.lanes) {
      const cu = lane.centerU(y);
      for (const band of lane.bands) {
        let sigmaV = band.sigmaV;
        // 拖尾：在迁移方向一侧指数衰减
        const dv = y - band.v;
        let tailFactor = 1;
        if (band.tail) {
          const dir = band.tail === 'down' ? 1 : -1;
          if (dv * dir > 0) {
            tailFactor = Math.exp(-dv * dir / (band.tailLen ?? 14));
          }
        }
        const gv = Math.exp(-(dv * dv) / (2 * sigmaV * sigmaV)) * tailFactor;
        if (gv < 0.002) continue;
        for (let x = 0; x < width; x++) {
          const du = x - cu;
          const gu = Math.exp(-(du * du) / (2 * band.halfWidth * band.halfWidth));
          const add = band.amp * gv * gu;
          if (add < 0.002) continue;
          f[y * width + x] += add;
        }
      }
    }
  }

  // 确定性伪噪声（种子来自尺寸，避免依赖随机状态，保证案例可重放）
  let seed = (width * 73856093) ^ (height * 19349663);
  const rnd = () => {
    seed ^= seed << 13;
    seed ^= seed >>> 17;
    seed ^= seed << 5;
    return ((seed >>> 0) % 10000) / 10000;
  };

  const mask = new Uint8Array(width * height);
  const out = new Uint8Array(width * height);
  for (let i = 0; i < f.length; i++) {
    let v = f[i] + (rnd() - 0.5) * noise;
    if (v >= sat) {
      mask[i] = 1;
      v = sat;
    }
    f[i] = Math.min(v, sat);
    out[i] = Math.max(0, Math.min(255, Math.round(v * 255)));
  }

  return {
    png: encodePngGray({ width, height, data: out }),
    width,
    height,
    float: f,
    saturationMask: mask
  };
}

/** 旋转/翻转 8 位灰度图（最近邻）。返回新图与像素映射元数据。 */
export function transformGray(img: GrayImage, rot: 0 | 90 | 180 | 270, flipH: boolean, flipV: boolean): GrayImage {
  const ops: Array<(i: GrayImage) => GrayImage> = [];
  if (flipH) ops.push((g) => flip(g, true, false));
  if (flipV) ops.push((g) => flip(g, false, true));
  if (rot === 90) ops.push(rotate90);
  if (rot === 180) ops.push((g) => rotate90(rotate90(g)));
  if (rot === 270) ops.push((g) => rotate90(rotate90(rotate90(g))));
  return ops.reduce((g, op) => op(g), img);
}

function flip(img: GrayImage, h: boolean, v: boolean): GrayImage {
  const { width: w, height: hh, data } = img;
  const out = new Uint8Array(w * hh);
  for (let y = 0; y < hh; y++) {
    for (let x = 0; x < w; x++) {
      const sx = h ? w - 1 - x : x;
      const sy = v ? hh - 1 - y : y;
      out[y * w + x] = data[sy * w + sx];
    }
  }
  return { width: w, height: hh, data: out };
}

function rotate90(img: GrayImage): GrayImage {
  const { width: w, height: h, data } = img;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 顺时针 90：新尺寸 h x w
      const nx = h - 1 - y;
      const ny = x;
      out[ny * h + nx] = data[y * w + x];
    }
  }
  return { width: h, height: w, data: out };
}
