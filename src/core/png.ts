import { deflateSync, inflateSync } from 'node:zlib';

export class PngError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngError';
  }
}

export interface PngImage {
  width: number;
  height: number;
  channels: number; // 1: gray, 2: gray+alpha, 3: rgb, 4: rgba
  data: Uint8Array;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePng(img: PngImage): Uint8Array {
  const { width, height, channels, data } = img;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = channels === 1 ? 0 : channels === 2 ? 4 : channels === 3 ? 2 : 6;
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const chunks: Buffer[] = [Buffer.from(SIG)];
  chunks.push(chunk('IHDR', ihdr));
  chunks.push(chunk('IDAT', deflateSync(raw, { level: 6 })));
  chunks.push(chunk('IEND', Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
}

function chunk(type: string, data: Buffer): Buffer {
  const out = Buffer.alloc(12 + data.length);
  out.writeUInt32BE(data.length, 0);
  out.write(type, 4, 'ascii');
  data.copy(out, 8);
  out.writeUInt32BE(crc32(out.subarray(4, 8 + data.length)), 8 + data.length);
  return out;
}

export function decodePng(bytes: Uint8Array): PngImage {
  if (bytes.length < 8 + 25) throw new PngError('文件短于 PNG 最小长度');
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) throw new PngError('PNG 签名不匹配');
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = -1, interlace = 0;
  const idat: Buffer[] = [];
  let seenIend = false;
  while (pos + 8 <= bytes.length) {
    const len = readUInt32(bytes, pos);
    const type = Buffer.from(bytes.subarray(pos + 4, pos + 8)).toString('ascii');
    if (pos + 12 + len > bytes.length) throw new PngError(`数据块 ${type} 长度越界`);
    const data = bytes.subarray(pos + 8, pos + 8 + len);
    const storedCrc = readUInt32(bytes, pos + 8 + len);
    if (crc32(bytes.subarray(pos + 4, pos + 8 + len)) !== storedCrc) {
      throw new PngError(`数据块 ${type} CRC 校验失败`);
    }
    if (type === 'IHDR') {
      if (len !== 13) throw new PngError('IHDR 长度非法');
      width = readUInt32(data, 0);
      height = readUInt32(data, 4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0) throw new PngError('仅支持 method 0 压缩');
      if (data[11] !== 0) throw new PngError('仅支持 method 0 滤波');
      interlace = data[12];
      if (interlace !== 0) throw new PngError('不支持隔行扫描 PNG');
      if (bitDepth !== 8) throw new PngError('仅支持 8 位 PNG');
      if (![0, 2, 4, 6].includes(colorType)) throw new PngError('不支持的颜色类型');
      if (width === 0 || height === 0 || width > 32768 || height > 32768) throw new PngError('图像尺寸非法');
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      seenIend = true;
      break;
    }
    pos += 12 + len;
  }
  if (!seenIend) throw new PngError('缺少 IEND 数据块');
  const channels = colorType === 0 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : 4;
  let inflated: Buffer;
  try {
    inflated = inflateSync(Buffer.concat(idat));
  } catch {
    throw new PngError('IDAT zlib 数据损坏');
  }
  const stride = width * channels;
  if (inflated.length !== (stride + 1) * height) throw new PngError('像素数据长度与尺寸不符');
  const out = Buffer.alloc(stride * height);
  const prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    const line = inflated.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const recon = Buffer.from(line);
    unfilter(filter, recon, prev, channels, stride);
    recon.copy(out, y * stride);
    recon.copy(prev);
  }
  return { width, height, channels, data: new Uint8Array(out) };
}

function unfilter(filter: number, cur: Buffer, prev: Buffer, bpp: number, stride: number): void {
  for (let i = 0; i < stride; i++) {
    const a = i >= bpp ? cur[i - bpp] : 0;
    const b = prev[i];
    const c = i >= bpp ? prev[i - bpp] : 0;
    switch (filter) {
      case 0: break;
      case 1: cur[i] = (cur[i] + a) & 0xff; break;
      case 2: cur[i] = (cur[i] + b) & 0xff; break;
      case 3: cur[i] = (cur[i] + ((a + b) >> 1)) & 0xff; break;
      case 4: cur[i] = (cur[i] + paeth(a, b, c)) & 0xff; break;
      default: throw new PngError('不支持的行滤波器类型 ' + filter);
    }
  }
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function readUInt32(buf: Uint8Array, off: number): number {
  return (buf[off] * 0x1000000 + (buf[off + 1] << 16) + (buf[off + 2] << 8) + buf[off + 3]) >>> 0;
}

export function toGray(img: PngImage): Uint8Array {
  const { width, height, channels, data } = img;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    gray[i] = channels >= 3
      ? Math.round(0.299 * data[i * channels] + 0.587 * data[i * channels + 1] + 0.114 * data[i * channels + 2])
      : data[i * channels];
  }
  return gray;
}
