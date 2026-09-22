import { deflateSync, inflateSync, crc32 } from 'node:zlib';
import { CorruptFormatError } from '../shared/diagnostic';

/**
 * 极简 PNG：8-bit grayscale（color type 0）。
 * 原始图像以灰度像素保存，叠加绘制在前端另存 RGBA。
 */
export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Uint8Array {
  if (gray.length !== width * height) throw new Error('像素长度与尺寸不符');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    gray.subarray(y * stride, (y + 1) * stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export interface DecodedPng {
  width: number;
  height: number;
  channels: number;
  data: Uint8Array;
}

export function decodePng(bytes: Uint8Array): DecodedPng {
  const buf = Buffer.from(bytes);
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== sig[i]) throw new CorruptFormatError('PNG 签名不匹配');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    if (pos + 8 > buf.length) throw new CorruptFormatError('PNG 被截断（chunk 头不完整）');
    const length = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const dataStart = pos + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > buf.length) throw new CorruptFormatError('PNG 被截断（chunk 数据不完整）');
    const data = buf.subarray(dataStart, dataEnd);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }
  if (!width || !height) throw new CorruptFormatError('PNG 缺少 IHDR');
  if (bitDepth !== 8) throw new CorruptFormatError(`仅支持 8-bit PNG，收到 ${bitDepth}`);
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0;
  if (!channels) throw new CorruptFormatError(`不支持的 PNG color type ${colorType}`);
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let src = 0;
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++]!;
    const line = inflated.subarray(src, src + stride);
    src += stride;
    const recon = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? recon[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v = line[x]!;
      if (filter === 0) v = v;
      else if (filter === 1) v = (v + a) & 255;
      else if (filter === 2) v = (v + b) & 255;
      else if (filter === 3) v = (v + ((a + b) >> 1)) & 255;
      else if (filter === 4) v = (v + paeth(a, b, c)) & 255;
      else throw new CorruptFormatError(`不支持的 PNG filter ${filter}`);
      recon[x] = v;
    }
    out.set(recon, y * stride);
    prev = recon;
  }
  return { width, height, channels, data: out };
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

export function toGrayscale(decoded: DecodedPng): Uint8Array {
  if (decoded.channels === 1) return decoded.data;
  const { width, height, channels, data } = decoded;
  const gray = new Uint8Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * channels]!;
    const g = channels > 1 ? data[i * channels + 1]! : r;
    const b = channels > 1 ? data[i * channels + 2]! : r;
    gray[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return gray;
}
