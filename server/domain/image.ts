import { COORD_BASIS, GrayImage, ImageContent } from './types';
import { makePrng } from './ids';

export type BandSpec = {
  laneX: number; // 泳道中心 x（px）
  y: number; // 未弯曲前的条带中心 y（px）
  intensity: number; // 0-255 峰值
  widthPx: number; // 横向半宽
  heightPx: number; // 纵向半宽
  saturated?: boolean; // 核心拉平到 255
  smearPx?: number; // 拖尾长度（向下）
};

export type GelSpec = {
  width: number;
  height: number;
  seed: number;
  smileAmplitude: number; // 微笑弯曲幅度（px），边缘泳道向下偏移
  lanes: number[]; // 各泳道中心 x
  bands: BandSpec[];
};

// 微笑弯曲：同一分子量的条带在不同 x 处出现不同 y。
export function smileOffset(x: number, width: number, amplitude: number): number {
  const cx = width / 2;
  const t = (x - cx) / (width / 2);
  return amplitude * t * t;
}

export function renderGelImage(spec: GelSpec): GrayImage {
  const { width, height } = spec;
  const data = new Uint8Array(width * height);
  const rand = makePrng(spec.seed);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const bg = 18 + 10 * (y / height) + rand() * 6;
      data[y * width + x] = Math.min(255, Math.round(bg));
    }
  }
  for (const band of spec.bands) {
    const cy = band.y + smileOffset(band.laneX, width, spec.smileAmplitude);
    const x0 = Math.max(0, Math.floor(band.laneX - band.widthPx * 3));
    const x1 = Math.min(width - 1, Math.ceil(band.laneX + band.widthPx * 3));
    const y0 = Math.max(0, Math.floor(cy - band.heightPx * 3 - (band.smearPx ?? 0)));
    const y1 = Math.min(height - 1, Math.ceil(cy + band.heightPx * 3 + (band.smearPx ?? 0)));
    for (let y = y0; y <= y1; y++) {
      for (let x = x0; x <= x1; x++) {
        const dx = (x - band.laneX) / band.widthPx;
        const dy = (y - cy) / band.heightPx;
        let v = band.intensity * Math.exp(-(dx * dx + dy * dy));
        if (band.smearPx && y > cy) {
          v += band.intensity * 0.35 * Math.exp(-dx * dx) * Math.exp(-(y - cy) / band.smearPx);
        }
        if (band.saturated && Math.abs(dx) < 0.8 && Math.abs(dy) < 0.8) v = 400; // 裁剪后平台
        const idx = y * width + x;
        data[idx] = Math.min(255, Math.max(data[idx], Math.round(v)));
      }
    }
  }
  return { width, height, format: 'gray8', basis: COORD_BASIS, data };
}

// 旋转返回新图像；像素级来源通过 orientation 材料记录，不丢原始表示。
export function rotateGray(img: GrayImage, deg: 90 | 180 | 270): GrayImage {
  const { width, height, data } = img;
  const out = new Uint8Array(width * height);
  let w = width;
  let h = height;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let nx: number;
      let ny: number;
      if (deg === 90) {
        nx = height - 1 - y;
        ny = x;
        w = height;
        h = width;
      } else if (deg === 180) {
        nx = width - 1 - x;
        ny = height - 1 - y;
      } else {
        nx = y;
        ny = width - 1 - x;
        w = height;
        h = width;
      }
      out[ny * w + nx] = data[y * width + x];
    }
  }
  return { width: w, height: h, format: 'gray8', basis: COORD_BASIS, data: out };
}

export function encodeImage(img: GrayImage): ImageContent {
  return {
    width: img.width,
    height: img.height,
    format: 'gray8',
    encoding: 'base64',
    basis: COORD_BASIS,
    data: Buffer.from(img.data).toString('base64'),
  };
}

export function decodeImage(content: ImageContent): GrayImage {
  return {
    width: content.width,
    height: content.height,
    format: 'gray8',
    basis: COORD_BASIS,
    data: new Uint8Array(Buffer.from(content.data, 'base64')),
  };
}
