// 极简灰度 PNG 编解码（IHDR/IDAT/IEND，zlib），服务端与测试使用。
import { deflateSync, inflateSync } from 'node:zlib';

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
}
const TABLE = crcTable();
function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
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

export function encodeGrayPng(width: number, height: number, pixels: Uint8Array | number[]): Buffer {
  if (pixels.length !== width * height) throw new Error('pixel length mismatch');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter none
    for (let x = 0; x < width; x++) raw[y * stride + 1 + x] = pixels[y * width + x];
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

export function decodeGrayPng(buf: Buffer): { width: number; height: number; pixels: Uint8Array } {
  if (buf.readUInt32BE(0) !== 0x89504e47) throw new Error('FORMAT_CORRUPT: not a PNG');
  let pos = 8;
  let width = 0;
  let height = 0;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 0) throw new Error('FORMAT_CORRUPT: only gray8 supported');
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    pos += 12 + len;
  }
  if (!width || !height) throw new Error('FORMAT_CORRUPT: missing IHDR');
  const raw = inflateSync(Buffer.concat(idat));
  const stride = width + 1;
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    if (raw[y * stride] !== 0) throw new Error('FORMAT_CORRUPT: unsupported row filter');
    raw.copy(pixels, y * width, y * stride + 1, y * stride + 1 + width) as unknown as void;
    for (let x = 0; x < width; x++) pixels[y * width + x] = raw[y * stride + 1 + x];
  }
  return { width, height, pixels };
}
