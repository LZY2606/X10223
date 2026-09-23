import { deflateSync, inflateSync, crc32 } from 'node:zlib';

/**
 * 最小 PNG 编解码：灰度 8-bit、单 IDAT。
 * 原图以 PNG bytes 对外导出；内部存储保留原始字节哈希。
 */

export function encodePngGray(width: number, height: number, pixels: Uint8Array): Buffer {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 = grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  // filter 0 (None) 每行前加一字节
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    pixels.subarray(y * width, (y + 1) * width).forEach((v, i) => {
      raw[y * (width + 1) + 1 + i] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface PngImage {
  width: number;
  height: number;
  pixels: Uint8Array;
}

export function decodePngGray(buffer: Uint8Array): PngImage {
  const buf = Buffer.from(buffer);
  if (buf.length < 8 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new FormatError('PNG 签名缺失或文件损坏');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < buf.length) {
    const len = buf.readUInt32BE(offset);
    const type = buf.subarray(offset + 4, offset + 8).toString('ascii');
    const dataStart = offset + 8;
    const data = buf.subarray(dataStart, dataStart + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    offset = dataStart + len + 4;
  }
  if (colorType !== 0 || bitDepth !== 8) {
    throw new FormatError(`仅支持灰度 8-bit PNG（收到 colorType=${colorType}, depth=${bitDepth}）`);
  }
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width + 1;
  if (inflated.length !== stride * height) {
    throw new FormatError('PNG 像素数据长度与 IHDR 不符（文件损坏）');
  }
  const pixels = new Uint8Array(width * height);
  let prev = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * stride];
    const line = inflated.subarray(y * stride + 1, y * stride + 1 + width);
    const recon = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      const a = x >= 1 ? recon[x - 1] : 0;
      const b = prev[x];
      const c = x >= 1 ? prev[x - 1] : 0;
      const raw = line[x];
      let v = raw;
      if (filter === 1) v = raw + a;
      else if (filter === 2) v = raw + b;
      else if (filter === 3) v = raw + Math.floor((a + b) / 2);
      else if (filter === 4) v = raw + paeth(a, b, c);
      else if (filter !== 0) throw new FormatError(`不支持的 PNG filter 类型 ${filter}`);
      recon[x] = v & 0xff;
    }
    recon.forEach((v, x) => {
      pixels[y * width + x] = v;
    });
    prev = recon;
  }
  return { width, height, pixels };
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

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 格式损坏（与语义无解、资源耗尽严格区分的一类结果） */
export class FormatError extends Error {
  constructor(message: string, public at?: string) {
    super(message);
    this.name = 'FormatError';
  }
}
