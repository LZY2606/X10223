import { deflateSync, inflateSync } from 'node:zlib';
import { createHash } from 'node:crypto';

/**
 * 极简 PNG 编解码（灰阶 8-bit / RGB 8-bit，无交错），完全离线。
 * 像素坐标原点为左上角，行内字节连续。
 */

export interface RawImage {
  width: number;
  height: number;
  channels: 1 | 3;
  /** length = width*height*channels，0..255 */
  data: Uint8Array;
}

function crcTable() {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const T = crcTable();
function crc32(buf: Buffer) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = T[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function encodePng(img: RawImage): Buffer {
  const { width, height, channels, data } = img;
  const colorType = channels === 1 ? 0 : 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    const row = Buffer.from(data.buffer, data.byteOffset + y * stride, stride);
    row.copy(raw, y * (stride + 1) + 1);
    prev = Buffer.from(row);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
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

export function decodePng(buf: Buffer): RawImage {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) {
    throw new FormatCorruptError('PNG 签名缺失或字节损坏');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let channels: 1 | 3 = 1;
  const idat: Buffer[] = [];
  while (offset < buf.length) {
    if (offset + 8 > buf.length) throw new FormatCorruptError('PNG chunk 头部被截断');
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const dataStart = offset + 8;
    if (dataStart + len + 4 > buf.length) throw new FormatCorruptError(`PNG ${type} 数据被截断`);
    const data = buf.subarray(dataStart, dataStart + len);
    const expectedCrc = buf.readUInt32BE(dataStart + len);
    if (crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) !== expectedCrc) {
      throw new FormatCorruptError(`PNG ${type} CRC 校验失败：文件可能半写/损坏`);
    }
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      const bitDepth = data[8];
      const colorType = data[9];
      if (bitDepth !== 8 || !(colorType === 0 || colorType === 2)) {
        throw new FormatCorruptError(`仅支持 8-bit 灰阶/RGB，收到 bitDepth=${bitDepth} colorType=${colorType}`);
      }
      channels = colorType === 0 ? 1 : 3;
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + len + 4;
  }
  if (!width || !height) throw new FormatCorruptError('缺少 IHDR');
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (inflated.length !== expected) {
    throw new FormatCorruptError(`解压后字节数 ${inflated.length} 与期望 ${expected} 不符（半写图像）`);
  }
  const out = new Uint8Array(width * height * channels);
  let prev = Buffer.alloc(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    const lineStart = y * (stride + 1) + 1;
    const cur = Buffer.alloc(stride);
    for (let x = 0; x < stride; x++) {
      const raw = inflated[lineStart + x];
      const a = x >= channels ? cur[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let v = raw;
      switch (filter) {
        case 0: v = raw; break;
        case 1: v = raw + a; break;
        case 2: v = raw + b; break;
        case 3: v = raw + ((a + b) >> 1); break;
        case 4: v = raw + paeth(a, b, c); break;
        default: throw new FormatCorruptError(`未知 PNG 过滤类型 ${filter}`);
      }
      cur[x] = v & 0xff;
    }
    cur.copy(out, y * stride);
    prev = cur;
  }
  return { width, height, channels, data: out };
}

export class FormatCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'FormatCorruptError';
  }
}

export function imageSha256(img: RawImage): string {
  return createHash('sha256').update(Buffer.from(img.data)).digest('hex');
}
