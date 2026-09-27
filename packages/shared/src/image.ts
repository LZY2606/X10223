import { deflateSync, inflateSync } from 'node:zlib';
import type { ImageChannelStats } from './types.js';

/** 通道统计：曝光分类、饱和像素比例（饱和条带判定依据）。 */
export function channelStats(gray: Uint8Array, budgetPixels?: number): ImageChannelStats {
  if (budgetPixels !== undefined && gray.length > budgetPixels) {
    const diag = new Error('RESOURCE_BUDGET_EXHAUSTED');
    (diag as Error & { code: string }).code = 'RESOURCE_BUDGET_EXHAUSTED';
    throw diag;
  }
  const histogram = new Array<number>(32).fill(0);
  let min = 255;
  let max = 0;
  let saturated = 0;
  for (let i = 0; i < gray.length; i++) {
    const v = gray[i]!;
    if (v < min) min = v;
    if (v > max) max = v;
    histogram[Math.min(31, v >> 3)]!++;
    if (v >= 250) saturated++;
  }
  const saturatedPixelFraction = gray.length ? saturated / gray.length : 0;
  let exposureClass: ImageChannelStats['exposureClass'] = 'normal';
  if (max <= 120 || (histogram.slice(0, 8).reduce((a, b) => a + b, 0) / Math.max(1, gray.length)) > 0.95) {
    exposureClass = 'underexposed';
  } else if (saturatedPixelFraction > 0.02) {
    exposureClass = 'overexposed';
  }
  return { min, max, saturatedPixelFraction, histogram, exposureClass };
}

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len, false);
  out.set(typeBytes, 4);
  out.set(data, 8);
  dv.setUint32(8 + len, crc32(out.subarray(4, 8 + len)), false);
  return out;
}

/** 8-bit grayscale PNG 编码（零依赖）。 */
export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Uint8Array {
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter none
    raw.set(gray.subarray(y * width, (y + 1) * width), y * stride + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 6 }));
  return concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) { out.set(p, off); off += p.length; }
  return out;
}

export interface DecodedPng {
  width: number;
  height: number;
  gray: Uint8Array;
}

/** 最小化的 PNG 解码器，支持本案例写出的 8-bit 灰度 PNG（含必要的滤镜反演）。 */
export function decodeGrayPng(bytes: Uint8Array): DecodedPng {
  if (bytes.length < 8 || bytes[0] !== 137 || bytes[1] !== 80 || bytes[2] !== 78 || bytes[3] !== 71) {
    const e = new Error('not a png');
    (e as Error & { code: string }).code = 'FORMAT_CORRUPT';
    throw e;
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: number[] = [];
  while (off < bytes.length) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + off);
    const len = dv.getUint32(0, false);
    const type = String.fromCharCode(bytes[off + 4]!, bytes[off + 5]!, bytes[off + 6]!, bytes[off + 7]!);
    const data = bytes.subarray(off + 8, off + 8 + len);
    if (type === 'IHDR') {
      width = new DataView(data.buffer, data.byteOffset).getUint32(0, false);
      height = new DataView(data.buffer, data.byteOffset).getUint32(4, false);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === 'IDAT') {
      for (let i = 0; i < data.length; i++) idat.push(data[i]!);
    } else if (type === 'IEND') {
      break;
    }
    off += 12 + len;
  }
  if (!width || !height) {
    const e = new Error('png truncated');
    (e as Error & { code: string }).code = 'FORMAT_CORRUPT';
    throw e;
  }
  if (colorType !== 0 || bitDepth !== 8) {
    const e = new Error('unsupported png (case pack only writes 8-bit gray)');
    (e as Error & { code: string }).code = 'FORMAT_CORRUPT';
    throw e;
  }
  const inflated = inflateSync(Uint8Array.from(idat));
  const stride = width + 1;
  const gray = new Uint8Array(width * height);
  const prev = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * stride]!;
    const rowStart = y * stride + 1;
    for (let x = 0; x < width; x++) {
      const raw = inflated[rowStart + x]!;
      const a = x > 0 ? gray[y * width + x - 1]! : 0;
      const b = prev[x]!;
      const c = x > 0 ? prev[x - 1]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = raw + pr;
          break;
        }
        default: {
          const e = new Error('bad filter');
          (e as Error & { code: string }).code = 'FORMAT_CORRUPT';
          throw e;
        }
      }
      gray[y * width + x] = v & 0xff;
    }
    gray.subarray(y * width, (y + 1) * width).forEach((v, i) => (prev[i] = v));
  }
  return { width, height, gray };
}

/** 旋转灰度像素（顺时针），显示帧派生；原图缓冲不被修改。 */
export function rotateGray(gray: Uint8Array, w: number, h: number, angleDeg: number): { gray: Uint8Array; width: number; height: number } {
  const norm = ((angleDeg % 360) + 360) % 360;
  if (norm === 0) return { gray: gray.slice(), width: w, height: h };
  const swap = norm === 90 || norm === 270;
  const nw = swap ? h : w;
  const nh = swap ? w : h;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx = 0;
      let ny = 0;
      if (norm === 90) { nx = h - 1 - y; ny = x; }
      else if (norm === 180) { nx = w - 1 - x; ny = h - 1 - y; }
      else if (norm === 270) { nx = y; ny = w - 1 - x; }
      out[ny * nw + nx] = gray[y * w + x]!;
    }
  }
  return { gray: out, width: nw, height: nh };
}
