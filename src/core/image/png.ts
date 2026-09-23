import { deflateSync, inflateSync } from 'node:zlib';
import type { Diagnostic } from '../types';

/**
 * 最小 PNG 编解码：
 *  - 编码：8 位灰度（color type 0），无隔行。
 *  - 解码：支持 8 位灰度(0)、RGB(2)、调色板(3)，无隔行；统一输出灰度。
 * 签名/CRC/截断错误 -> FORMAT_CORRUPT。
 */

const SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf: Buffer): number {
  let c: number;
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let cachedTable: Uint32Array | null = null;
function crcTable(): Uint32Array {
  if (cachedTable) return cachedTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  cachedTable = table;
  return table;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export interface DecodedImage {
  width: number;
  height: number;
  channels: 1 | 3;
  bitDepth: number;
  gray: Uint8Array;
}

export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Buffer {
  if (gray.length !== width * height) throw new Error('gray buffer size mismatch');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    raw.set(gray.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    SIGNATURE,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

export class PngFormatError extends Error {
  diagnostic: Diagnostic;
  constructor(message: string, path = '/image') {
    super(message);
    this.name = 'PngFormatError';
    this.diagnostic = { code: 'FORMAT_CORRUPT', message, path, severity: 'error' };
  }
}

export function decodePng(bytes: Uint8Array): DecodedImage {
  const buf = Buffer.from(bytes);
  if (buf.length < 8 + 12 + 12 || !buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new PngFormatError('PNG 签名缺失或文件截断');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  let palette: Uint8Array | null = null;
  let sawIend = false;

  while (offset < buf.length) {
    if (offset + 8 > buf.length) throw new PngFormatError('PNG 块长度截断');
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) throw new PngFormatError(`PNG 块 ${type} 数据截断`);
    const data = buf.subarray(dataStart, dataEnd);
    const crcStored = buf.readUInt32BE(dataEnd);
    if (crc32(Buffer.concat([Buffer.from(type, 'ascii'), Buffer.from(data)])) !== crcStored) {
      throw new PngFormatError(`PNG 块 ${type} CRC 校验失败`);
    }
    switch (type) {
      case 'IHDR': {
        if (len !== 13) throw new PngFormatError('IHDR 长度非法');
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8];
        colorType = data[9];
        if (data[12] !== 0) throw new PngFormatError('暂不支持隔行 PNG');
        if (bitDepth !== 8) throw new PngFormatError(`暂不支持位深 ${bitDepth}`);
        if (![0, 2, 3].includes(colorType)) {
          throw new PngFormatError(`暂不支持 color type ${colorType}`);
        }
        break;
      }
      case 'PLTE':
        palette = new Uint8Array(data);
        break;
      case 'IDAT':
        idat.push(Buffer.from(data));
        break;
      case 'IEND':
        sawIend = true;
        break;
    }
    offset = dataEnd + 4;
  }
  if (!sawIend) throw new PngFormatError('缺少 IEND 块');

  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat));
  } catch {
    throw new PngFormatError('IDAT 数据无法解压');
  }

  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 1;
  const bpp = colorType === 3 ? 1 : channels;
  const stride = width * bpp;
  const expected = (stride + 1) * height;
  if (inflated.length !== expected) {
    throw new PngFormatError(`像素数据长度 ${inflated.length} 与期望 ${expected} 不符`);
  }

  const gray = new Uint8Array(width * height);
  let prevRow = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    const row = Uint8Array.from(inflated.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride));
    applyFilter(row, prevRow, filter, bpp);
    for (let x = 0; x < width; x++) {
      if (colorType === 0) gray[y * width + x] = row[x];
      else if (colorType === 2) {
        gray[y * width + x] = Math.round(0.299 * row[x * 3] + 0.587 * row[x * 3 + 1] + 0.114 * row[x * 3 + 2]);
      } else if (palette) {
        const idx = row[x] * 3;
        gray[y * width + x] = Math.round(
          0.299 * palette[idx] + 0.587 * palette[idx + 1] + 0.114 * palette[idx + 2]
        );
      }
    }
    prevRow = row;
  }
  return { width, height, channels: colorType === 2 ? 3 : 1, bitDepth, gray };
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

function applyFilter(row: Uint8Array, prev: Uint8Array, filter: number, bpp: number): void {
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? row[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    let v = row[i];
    if (filter === 1) v += a;
    else if (filter === 2) v += b;
    else if (filter === 3) v += Math.floor((a + b) / 2);
    else if (filter === 4) v += paeth(a, b, c);
    else if (filter !== 0) throw new PngFormatError(`不支持的行滤波类型 ${filter}`);
    row[i] = v & 0xff;
  }
}
