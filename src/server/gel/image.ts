import type { GelImagePayload } from '../../shared/types';

// 合成凝胶图像：泳道带微笑弯曲，条带为高斯亮斑。领域案例包专用，非通用表格。
export interface SynthBand {
  laneIdx: number;
  yPx: number;
  amplitude: number; // 峰值灰度（>255 将被截断 -> 饱和）
  halfWidthPx: number;
}

export interface SynthSpec {
  width: number;
  height: number;
  laneCenters: number[]; // 各泳道中心 x
  curveK: number;        // 微笑弯曲：x(y) = cx + curveK*(y-yRef)^2
  yRef: number;
  laneHalfWidth: number;
  background: number;
  bands: SynthBand[];
}

export function laneXAt(cx: number, curveK: number, yRef: number, y: number): number {
  return cx + curveK * (y - yRef) * (y - yRef);
}

export function synthesizeGel(spec: SynthSpec): GelImagePayload {
  const { width, height } = spec;
  const pixels = new Array<number>(width * height).fill(spec.background);
  for (const b of spec.bands) {
    const cx = spec.laneCenters[b.laneIdx];
    const x0 = laneXAt(cx, spec.curveK, spec.yRef, b.yPx);
    const sigmaY = Math.max(1.2, b.halfWidthPx / 1.6);
    const sigmaX = Math.max(2.0, spec.laneHalfWidth / 2.2);
    const rY = Math.ceil(sigmaY * 3);
    const rX = Math.ceil(sigmaX * 3);
    for (let dy = -rY; dy <= rY; dy++) {
      const y = Math.round(b.yPx) + dy;
      if (y < 0 || y >= height) continue;
      const xc = laneXAt(cx, spec.curveK, spec.yRef, y);
      for (let dx = -rX; dx <= rX; dx++) {
        const x = Math.round(x0) + dx;
        if (x < 0 || x >= width) continue;
        const gx = (x - xc) / sigmaX;
        const gy = (y - b.yPx) / sigmaY;
        const v = b.amplitude * Math.exp(-0.5 * (gx * gx + gy * gy));
        const idx = y * width + x;
        pixels[idx] = Math.min(255, pixels[idx] + v);
      }
    }
  }
  return { width, height, pixels: pixels.map((v) => Math.round(v)) };
}

// 旋转 90°（顺时针）：wells-top -> wells-left。只改拍摄方向这一个直接来源。
export function rotate90(img: GelImagePayload): GelImagePayload {
  const { width, height, pixels } = img;
  const out = new Array<number>(width * height).fill(0);
  const nw = height;
  const nh = width;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = height - 1 - y;
      const ny = x;
      out[ny * nw + nx] = pixels[y * width + x];
    }
  }
  return { width: nw, height: nh, pixels: out };
}
