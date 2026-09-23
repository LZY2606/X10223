import { deflateSync, inflateSync } from 'node:zlib';
import { sha256Bytes } from './hash.js';
import { FormatCorruptError } from './errors.js';
import { diagnostic } from './diagnostics.js';
import type { ImageMaterial, Polyline, Vec2 } from './types.js';
import { cumulativeArcMm, pointAtArcMm } from './geometry.js';

/**
 * raw8 自有无损格式（领域专用，非通用表格）：
 *   magic "GELRAW8\n" | width:BE32 | height:BE32 | zlib(uint8 grayscale)
 * 8 位灰度，单通道；饱和值 = 2^bitDepth-1。
 */
const MAGIC = Buffer.from('GELRAW8\n', 'ascii');

export class RawImage {
  readonly sha256: string;
  constructor(
    readonly width: number,
    readonly height: number,
    readonly data: Uint8Array,
  ) {
    if (data.length !== width * height) throw new Error('raw8 像素数不匹配');
    this.sha256 = sha256Bytes(Buffer.from(data));
  }
  get(x: number, y: number): number {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return 0;
    return this.data[y * this.width + x];
  }
  set(x: number, y: number, v: number) {
    x = Math.round(x);
    y = Math.round(y);
    if (x < 0 || y < 0 || x >= this.width || y >= this.height) return;
    this.data[y * this.width + x] = Math.max(0, Math.min(255, Math.round(v)));
  }
  clone(): RawImage {
    return new RawImage(this.width, this.height, Uint8Array.from(this.data));
  }
  encode(): Buffer {
    const header = Buffer.alloc(16);
    MAGIC.copy(header, 0);
    header.writeUInt32BE(this.width, 8);
    header.writeUInt32BE(this.height, 12);
    return Buffer.concat([header, deflateSync(Buffer.from(this.data))]);
  }
  static decode(bytes: Uint8Array | Buffer): RawImage {
    const buf = Buffer.from(bytes);
    if (buf.length < 16 || !buf.subarray(0, 8).equals(MAGIC)) {
      throw new FormatCorruptError('raw8 魔数缺失或截断', [
        diagnostic('FORMAT_CORRUPT', 'error', '不是合法的 GELRAW8 图像（魔数不匹配）', { path: 'rawImage.blob' }),
      ]);
    }
    const width = buf.readUInt32BE(8);
    const height = buf.readUInt32BE(12);
    if (width === 0 || height === 0 || width > 65535 || height > 65535) {
      throw new FormatCorruptError('raw8 尺寸非法', [
        diagnostic('FORMAT_CORRUPT', 'error', `非法尺寸 ${width}x${height}`, { path: 'rawImage.header' }),
      ]);
    }
    let data: Buffer;
    try {
      data = inflateSync(buf.subarray(16));
    } catch {
      throw new FormatCorruptError('raw8 像素块 zlib 损坏', [
        diagnostic('FORMAT_CORRUPT', 'error', 'zlib 解压失败，像素数据损坏', { path: 'rawImage.pixels' }),
      ]);
    }
    if (data.length !== width * height) {
      throw new FormatCorruptError('raw8 像素数与尺寸不符', [
        diagnostic('FORMAT_CORRUPT', 'error', `期望 ${width * height} 字节，实得 ${data.length}`, {
          path: 'rawImage.pixels',
        }),
      ]);
    }
    return new RawImage(width, height, new Uint8Array(data));
  }
}

export function rotateCW(img: RawImage, deg: 90 | 180 | 270): RawImage {
  if (deg === 180) {
    const out = new RawImage(img.width, img.height, new Uint8Array(img.data.length));
    for (let y = 0; y < img.height; y++)
      for (let x = 0; x < img.width; x++) out.set(img.width - 1 - x, img.height - 1 - y, img.get(x, y));
    return out;
  }
  const w = img.height;
  const h = img.width;
  const out = new RawImage(w, h, new Uint8Array(w * h));
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      if (deg === 90) out.set(img.height - 1 - y, x, img.get(x, y));
      else out.set(y, img.width - 1 - x, img.get(x, y));
    }
  }
  return out;
}

/** 在暗背景上叠加一个高斯亮带（可指定饱和强度）。 */
export function paintGaussianBand(
  img: RawImage,
  cx: number,
  cy: number,
  sigmaX: number,
  sigmaY: number,
  amplitude: number,
  tail?: { dir: 1 | -1; lengthPx: number },
) {
  const r = Math.ceil(Math.max(sigmaX, sigmaY) * 3.2) + (tail ? tail.lengthPx : 0);
  for (let y = Math.max(0, cy - r); y <= Math.min(img.height - 1, cy + r); y++) {
    for (let x = Math.max(0, cx - r); x <= Math.min(img.width - 1, cx + r); x++) {
      const gx = Math.exp(-(((x - cx) / sigmaX) ** 2) / 2);
      let gy = Math.exp(-(((y - cy) / sigmaY) ** 2) / 2);
      if (tail) {
        const dy = (y - cy) * tail.dir;
        if (dy > 0) gy += 0.55 * Math.exp(-dy / tail.lengthPx) * Math.exp(-(((x - cx) / sigmaX) ** 2) / 2);
      }
      img.set(x, y, Math.min(255, img.get(x, y) + amplitude * gx * gy));
    }
  }
}

export function darkImage(width: number, height: number, background = 24): RawImage {
  return new RawImage(
    width,
    height,
    Uint8Array.from({ length: width * height }, () => background + Math.round((Math.random() - 0.5) * 6)),
  );
}

/** 区域内饱和像素占比（阈值默认 250）。 */
export function saturatedFraction(img: RawImage, cx: number, cy: number, rx: number, ry: number, threshold = 250): number {
  let sat = 0;
  let n = 0;
  for (let y = Math.max(0, cy - ry); y <= Math.min(img.height - 1, cy + ry); y++) {
    for (let x = Math.max(0, cx - rx); x <= Math.min(img.width - 1, cx + rx); x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      if (dx * dx + dy * dy <= 1) {
        n++;
        if (img.get(x, y) >= threshold) sat++;
      }
    }
  }
  return n ? sat / n : 0;
}

/** 沿泳道中心线采样剖面（从迁移起点向下）。 */
export function sampleAlongLane(
  img: RawImage,
  image: ImageMaterial,
  centerline: Polyline,
  halfWidthPx: number,
  stepPx = 1,
): { originPx: Vec2; stepMm: number; values: number[] } {
  const acc = cumulativeArcMm(centerline, image);
  const totalPx = acc[acc.length - 1] / ((image.pixelSpacing.x + image.pixelSpacing.y) / 2);
  const stepMm = stepPx * image.pixelSpacing.y;
  const values: number[] = [];
  const first = pointAtArcMm(centerline, image, 0).point;
  for (let s = 0; s <= totalPx * image.pixelSpacing.y + 1e-6; s += stepMm) {
    const { point, normal } = pointAtArcMm(centerline, image, s);
    let sum = 0;
    let cnt = 0;
    for (let off = -halfWidthPx; off <= halfWidthPx; off++) {
      const sx = point.x + normal.x * off;
      const sy = point.y + normal.y * off;
      sum += img.get(sx, sy);
      cnt++;
    }
    values.push(cnt ? sum / cnt : 0);
  }
  return { originPx: first, stepMm, values };
}

/** 沿泳道方向在给定弧长处做横向剖面，用于判断重叠/宽度。 */
export function sampleAcrossLane(
  img: RawImage,
  image: ImageMaterial,
  centerline: Polyline,
  sMm: number,
  halfWidthPx: number,
): number[] {
  const { point, normal } = pointAtArcMm(centerline, image, sMm);
  const values: number[] = [];
  for (let off = -halfWidthPx; off <= halfWidthPx; off++) {
    values.push(img.get(point.x + normal.x * off, point.y + normal.y * off));
  }
  return values;
}

/** 简单的一维局部极大峰检测（自动候选）。 */
export function findPeaks(values: number[], minProminence = 18): { index: number; prominence: number }[] {
  const peaks: { index: number; prominence: number }[] = [];
  for (let i = 2; i < values.length - 2; i++) {
    if (values[i] > values[i - 1] && values[i] >= values[i + 1] && values[i] > values[i - 2] && values[i] >= values[i + 2]) {
      const left = Math.min(...values.slice(Math.max(0, i - 12), i));
      const right = Math.min(...values.slice(i + 1, Math.min(values.length, i + 13)));
      const prominence = values[i] - Math.max(left, right);
      if (prominence >= minProminence) peaks.push({ index: i, prominence });
    }
  }
  return peaks;
}
