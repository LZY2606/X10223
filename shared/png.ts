/**
 * 最小 PNG 编解码（8-bit gray / RGB / RGBA），服务端与测试直接可用。
 * 编码仅依赖 zlib deflate；解码支持合成器生成的所有 PNG（含 filter 0-4）。
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface Raster {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  data: Uint8Array;
}

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const CRC_TAB = crcTable();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TAB[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function encodePng(raster: Raster): Buffer {
  const { width, height, channels, data } = raster;
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const bitDepth = 8;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.subarray(y * stride, (y + 1) * stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(buf: Buffer): Raster {
  if (buf.length < 8 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('PNG 签名错误');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    switch (type) {
      case 'IHDR':
        width = data.readUInt32BE(0);
        height = data.readUInt32BE(4);
        bitDepth = data[8]!;
        colorType = data[9]!;
        break;
      case 'IDAT':
        idat.push(Buffer.from(data));
        break;
      case 'IEND':
        pos = buf.length;
        continue;
    }
    pos += 12 + len;
  }
  if (bitDepth !== 8 || ![0, 2, 6].includes(colorType)) {
    throw new Error(`不支持的 PNG 格式 bitDepth=${bitDepth} colorType=${colorType}`);
  }
  const channels = (colorType === 0 ? 1 : colorType === 2 ? 3 : 4) as 1 | 3 | 4;
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  const prev = Buffer.alloc(stride);
  const cur = Buffer.alloc(stride);
  let srcPos = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[srcPos++]!;
    for (let x = 0; x < stride; x++) cur[x] = inflated[srcPos++]!;
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      const rawByte = cur[x]!;
      let v: number;
      switch (filter) {
        case 0: v = rawByte; break;
        case 1: v = (rawByte + a) & 0xff; break;
        case 2: v = (rawByte + b) & 0xff; break;
        case 3: v = (rawByte + ((a + b) >> 1)) & 0xff; break;
        case 4: v = (rawByte + paeth(a, b, c)) & 0xff; break;
        default: throw new Error(`不支持的 PNG filter: ${filter}`);
      }
      cur[x] = v;
      out[y * stride + x] = v;
    }
    cur.copy(prev);
  }
  return { width, height, channels, data: out };
}

export function toGray(raster: Raster): Uint8Array {
  if (raster.channels === 1) return raster.data;
  const { width, height, data } = raster;
  const gray = new Uint8Array(width * height);
  const ch = raster.channels;
  for (let i = 0; i < width * height; i++) {
    gray[i] = Math.round(0.299 * data[i * ch]! + 0.587 * data[i * ch + 1]! + 0.114 * data[i * ch + 2]!);
  }
  return gray;
}
