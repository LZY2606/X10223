import { deflateSync, inflateSync } from "node:zlib";

// 极简 PNG：灰度 8/16-bit。保留原始位深——饱和阈值依 maxIntensity 决定。
export interface GrayImage {
  width: number;
  height: number;
  bitDepth: 8 | 16;
  /** 行优先强度 0..maxValue */
  data: Uint16Array;
}

export function maxValue(bitDepth: 8 | 16): number {
  return bitDepth === 8 ? 255 : 65535;
}

function crc32(buf: Buffer): number {
  let c = ~0;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i]!;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function encodePng(img: GrayImage): Buffer {
  const { width, height, bitDepth, data } = img;
  const bytesPerPixel = bitDepth === 8 ? 1 : 2;
  const stride = width * bytesPerPixel;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    for (let x = 0; x < width; x++) {
      const v = data[y * width + x]!;
      if (bitDepth === 8) raw[y * (stride + 1) + 1 + x] = v;
      else raw[y * (stride + 1) + 1 + x * 2] = (v >> 8) & 0xff;
      if (bitDepth === 16) raw[y * (stride + 1) + 1 + x * 2 + 1] = v & 0xff;
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return Buffer.concat([
    sig,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

/** 解析 PNG（灰度/真彩，8/16bit，filter 0-4）。损坏时抛带位置信息的错误。 */
export function decodePng(buf: Buffer): GrayImage {
  if (buf.length < 8 || !buf.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new PngError("PNG 签名缺失/损坏", 0);
  }
  let off = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = -1;
  let idat = Buffer.alloc(0);
  while (off < buf.length) {
    if (off + 8 > buf.length) throw new PngError("截断的 chunk 头", off);
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString("ascii");
    const dataStart = off + 8;
    if (dataStart + len + 4 > buf.length) throw new PngError(`chunk ${type} 被截断`, off);
    const data = buf.subarray(dataStart, dataStart + len);
    if (type === "IHDR") {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === "IDAT") {
      idat = Buffer.concat([idat, Buffer.from(data)]);
    } else if (type === "IEND") {
      break;
    }
    off = dataStart + len + 4;
  }
  if (!width || !height) throw new PngError("缺少 IHDR", 8);
  if (colorType !== 0 && colorType !== 2) throw new PngError(`不支持的 colorType=${colorType}（仅灰度/真彩）`, 8);
  if (bitDepth !== 8 && bitDepth !== 16) throw new PngError(`不支持的位深 ${bitDepth}`, 8);
  const channels = colorType === 0 ? 1 : 3;
  const bpp = (bitDepth / 8) * channels;
  const stride = width * bpp;
  let raw: Buffer;
  try {
    raw = inflateSync(idat);
  } catch {
    throw new PngError("IDAT 解压失败（格式损坏）", 0);
  }
  const out = new Uint16Array(width * height);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    if (rowStart + stride + 1 > raw.length) throw new PngError("扫描线数据不完整", rowStart);
    const filter = raw[rowStart]!;
    const cur = Buffer.from(raw.subarray(rowStart + 1, rowStart + 1 + stride));
    unfilter(filter, cur, prev, bpp, stride);
    for (let x = 0; x < width; x++) {
      let v: number;
      if (colorType === 0) {
        v = bitDepth === 8 ? cur[x]! : cur.readUInt16BE(x * 2);
      } else {
        const i = x * bpp;
        const r = bitDepth === 8 ? cur[i]! : cur.readUInt16BE(i);
        const g = bitDepth === 8 ? cur[i + 1]! : cur.readUInt16BE(i + 2);
        const b = bitDepth === 8 ? cur[i + 2]! : cur.readUInt16BE(i + 4);
        v = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }
      out[y * width + x] = v;
    }
    cur.copy(prev);
  }
  return { width, height, bitDepth: bitDepth as 8 | 16, data: out };
}

class PngError extends Error {
  constructor(message: string, readonly byteOffset: number) {
    super(message);
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}
function unfilter(filter: number, cur: Buffer, prev: Buffer, bpp: number, stride: number): void {
  for (let i = 0; i < stride; i++) {
    const x = cur[i]!;
    const a = i >= bpp ? cur[i - bpp]! : 0;
    const b = prev[i]!;
    const c = i >= bpp ? prev[i - bpp]! : 0;
    let v = x;
    if (filter === 1) v = x + a;
    else if (filter === 2) v = x + b;
    else if (filter === 3) v = x + ((a + b) >> 1);
    else if (filter === 4) v = x + paeth(a, b, c);
    else if (filter !== 0) throw new PngError(`非法 filter 类型 ${filter}`, 0);
    cur[i] = v & 0xff;
  }
}
