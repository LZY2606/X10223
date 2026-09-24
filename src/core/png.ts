import { PNG } from 'pngjs';

/** 8 位灰度栅格；PNG 仅作序列化格式，内部一律灰度矩阵。 */
export interface GrayRaster {
  width: number;
  height: number;
  /** 行优先，0..255 */
  data: Uint8Array;
}

export function createRaster(width: number, height: number, fill = 0): GrayRaster {
  return { width, height, data: new Uint8Array(width * height).fill(fill) };
}

export function encodePng(r: GrayRaster): Buffer {
  const png = new PNG({ width: r.width, height: r.height, colorType: 0, bitDepth: 8 });
  png.data = Buffer.from(r.data.buffer, r.data.byteOffset, r.data.byteLength);
  return PNG.sync.write(png);
}

export function decodePng(buf: Buffer): GrayRaster {
  const png = PNG.sync.read(buf);
  const { width, height } = png;
  const data = new Uint8Array(width * height);
  // 统一转灰度（pngjs 输出 RGBA）
  for (let i = 0; i < width * height; i++) {
    const r = png.data[i * 4];
    const g = png.data[i * 4 + 1];
    const b = png.data[i * 4 + 2];
    data[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return { width, height, data };
}

/** 像素级精确的 90/180/270 旋转（用于"旋转图像"情形，等价输入 => 稳定输出）。 */
export function rotateRaster(r: GrayRaster, deg: 90 | 180 | 270): GrayRaster {
  const out = deg === 180
    ? createRaster(r.width, r.height)
    : createRaster(r.height, r.width);
  for (let y = 0; y < r.height; y++) {
    for (let x = 0; x < r.width; x++) {
      const v = r.data[y * r.width + x];
      let nx: number, ny: number;
      if (deg === 90) { nx = r.height - 1 - y; ny = x; }
      else if (deg === 180) { nx = r.width - 1 - x; ny = r.height - 1 - y; }
      else { nx = y; ny = r.width - 1 - x; }
      out.data[ny * out.width + nx] = v;
    }
  }
  return out;
}

export function sampleBilinear(r: GrayRaster, x: number, y: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y);
  const x1 = x0 + 1, y1 = y0 + 1;
  const fx = x - x0, fy = y - y0;
  const at = (xx: number, yy: number) =>
    xx < 0 || yy < 0 || xx >= r.width || yy >= r.height ? 0 : r.data[yy * r.width + xx];
  return (
    at(x0, y0) * (1 - fx) * (1 - fy) +
    at(x1, y0) * fx * (1 - fy) +
    at(x0, y1) * (1 - fx) * fy +
    at(x1, y1) * fx * fy
  );
}
