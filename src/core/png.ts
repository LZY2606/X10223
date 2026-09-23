import { deflateSync, inflateSync } from 'node:zlib';

/**
 * 极简 PNG：只支持 8 位灰度（colorType=0），离线案例包无需第三方图像库。
 * 像素以行主序存储，每行前加 1 字节 filter(0)。
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export interface GrayImage {
  width: number;
  height: number;
  /** 0..255 灰度，行主序 */
  data: Uint8Array;
}

export function encodePngGray(img: GrayImage): Buffer {
  const { width, height, data } = img;
  if (data.length !== width * height) throw new Error('encodePngGray: size mismatch');
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    data.subarray(y * width, (y + 1) * width).forEach((g, x) => {
      raw[y * (width + 1) + 1 + x] = g;
    });
  }
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

export function decodePngGray(buf: Buffer): GrayImage {
  if (buf.length < 8 || buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    throw new Error('corrupt-format: not a PNG');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    if (off + 8 > buf.length) throw new Error('corrupt-format: truncated chunk header');
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('ascii');
    const start = off + 8;
    if (start + len + 4 > buf.length) throw new Error('corrupt-format: truncated chunk body');
    const data = buf.subarray(start, start + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8 || colorType !== 0) {
        throw new Error(`corrupt-format: only 8-bit grayscale supported (depth=${bitDepth} type=${colorType})`);
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off = start + len + 4;
  }
  if (!width || !height) throw new Error('corrupt-format: missing IHDR');
  const raw = inflateSync(Buffer.concat(idat));
  const expect = (width + 1) * height;
  if (raw.length < expect) throw new Error('corrupt-format: short scanline data');
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * (width + 1)];
    if (filter !== 0) throw new Error(`corrupt-format: unsupported filter ${filter} (only none)`);
    raw.copy(Buffer.from(out.buffer, y * width, width), 0, y * (width + 1) + 1, y * (width + 1) + 1 + width);
  }
  return { width, height, data: out };
}
