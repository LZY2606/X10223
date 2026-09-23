import type { GelImage, LaneDef } from '../shared/types';

export interface SampleBandSpec {
  laneId: string;
  y: number; // 名义位置（微笑弯曲前的 y）
  amplitude: number; // 0-255
  sigma: number; // 垂直方向宽度 px
  saturate?: boolean; // 幅度超出 255 → 平台饱和
  tail?: number; // 拖尾长度 px（向下指数衰减）
}

export interface GelSpec {
  width: number;
  height: number;
  lanes: LaneDef[];
  ladderLaneId: string;
  ladderSizesBp: number[]; // 标称值（降序）
  ladderBandYs: number[]; // 实际出现的 ladder 带（长度可小于 sizes → 缺带）
  ladderSizesPresent: number[]; // 与 ladderBandYs 一一对应的标称值
  sampleBands: SampleBandSpec[];
  smile: number; // 微笑弯曲强度：边缘下陷像素数
  noise: number;
  background: number;
}

/** 微笑弯曲：同一名义 y 在 x 处的实际位移。dy >= 0，边缘大、中心小。 */
export function smileOffset(x: number, width: number, smile: number): number {
  const t = (x - width / 2) / (width / 2);
  return smile * t * t;
}

/** 泳道曲线：y(x) = y0 + smileOffset。lane 曲线随泳道中心 x 走。 */
export function laneCurveOffset(spec: { width: number; smile: number }, x: number): number {
  return smileOffset(x, spec.width, spec.smile);
}

/** 合成凝胶图像：ladder + 样品带 + 微笑弯曲 + 饱和 + 拖尾 + 噪声。 */
export function renderGel(spec: GelSpec): GelImage {
  const { width: w, height: h } = spec;
  const px = new Float64Array(w * h).fill(spec.background);
  const paintBand = (xCenter: number, halfW: number, y0: number, amp: number, sigma: number, tail: number) => {
    for (let x = Math.max(0, Math.floor(xCenter - halfW)); x <= Math.min(w - 1, Math.ceil(xCenter + halfW)); x++) {
      const dy = smileOffset(x, w, spec.smile);
      const yc = y0 + dy;
      const yTop = Math.max(0, Math.floor(yc - 4 * sigma));
      const yBot = Math.min(h - 1, Math.ceil(yc + 4 * sigma + tail));
      for (let y = yTop; y <= yBot; y++) {
        const d = y - yc;
        let v = amp * Math.exp(-(d * d) / (2 * sigma * sigma));
        if (tail > 0 && d > 0) v += amp * 0.35 * Math.exp(-d / tail);
        const lat = Math.exp(-((x - xCenter) ** 2) / (2 * (halfW * 0.7) ** 2));
        px[y * w + x] += v * lat;
      }
    }
  };
  // ladder 带
  const ladderLane = spec.lanes.find((l) => l.id === spec.ladderLaneId)!;
  spec.ladderBandYs.forEach((y) => paintBand(ladderLane.xCenter, ladderLane.halfWidth, y, 200, 2.2, 0));
  // 样品带
  for (const b of spec.sampleBands) {
    const lane = spec.lanes.find((l) => l.id === b.laneId);
    if (!lane) continue;
    paintBand(lane.xCenter, lane.halfWidth, b.y, b.amplitude, b.sigma, b.tail ?? 0);
  }
  const out = new Uint8Array(w * h);
  let seed = 42;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < w * h; i++) {
    const v = px[i] + spec.noise * (rand() - 0.5);
    out[i] = v >= 255 ? 255 : v <= 0 ? 0 : Math.round(v); // 饱和截断发生在这里
  }
  return { width: w, height: h, pixels: out };
}

/** 旋转 90°。返回新图；坐标基准变化由调用方在材料层记录。 */
export function rotate90(img: GelImage, dir: 'cw' | 'ccw'): GelImage {
  const { width: w, height: h, pixels } = img;
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      if (dir === 'cw') out[x * h + (h - 1 - y)] = pixels[y * w + x];
      else out[(w - 1 - x) * h + y] = pixels[y * w + x];
    }
  return { width: h, height: w, pixels: out };
}

/** 沿泳道曲线取平均强度剖面（垂直方向）。 */
export function laneProfile(img: GelImage, lane: LaneDef, smile: number): Float64Array {
  const { width: w, height: h, pixels } = img;
  const prof = new Float64Array(h);
  const x0 = Math.max(0, Math.round(lane.xCenter - lane.halfWidth * 0.6));
  const x1 = Math.min(w - 1, Math.round(lane.xCenter + lane.halfWidth * 0.6));
  for (let y = 0; y < h; y++) {
    let sum = 0, n = 0;
    for (let x = x0; x <= x1; x++) {
      const yy = Math.round(y - smileOffset(x, w, smile) + smileOffset(lane.xCenter, w, smile));
      if (yy >= 0 && yy < h) { sum += pixels[yy * w + x]; n++; }
    }
    prof[y] = n ? sum / n : 0;
  }
  return prof;
}
