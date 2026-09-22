// 最小 8-bit grayscale + RGB PNG 编解码（仅依赖 node:zlib / node:crypto CRC）
import { deflateSync, inflateSync } from 'node:zlib';
import { crc32 } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

/** grayscale 0..255, 每行前加 filter byte 0 */
export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Buffer {
  if (gray.length !== width * height) throw new Error('gray buffer size mismatch');
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    gray.subarray(y * width, (y + 1) * width);
    Buffer.from(gray.buffer, gray.byteOffset + y * width, width).copy(raw, y * stride + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export interface DecodedGray {
  width: number;
  height: number;
  gray: Uint8Array;
  colorType: number;
}

/** 支持灰度(0)/RGB(2)/RGBA(6)，8 bit */
export function decodeToGray(png: Buffer): DecodedGray {
  if (png.readUInt32BE(0) !== 0x89504e47) throw new Error('not a png');
  let pos = 8;
  let width = 0;
  let height = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (pos < png.length) {
    const len = png.readUInt32BE(pos);
    const type = png.subarray(pos + 4, pos + 8).toString('ascii');
    const data = png.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
      if (data[8] !== 8) throw new Error('unsupported bit depth');
    } else if (type === 'IDAT') idat.push(Buffer.from(data));
    pos += 12 + len;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  const stride = width * channels + 1;
  const gray = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = raw[y * stride];
    if (filter !== 0) throw new Error(`unsupported filter ${filter}`);
    for (let x = 0; x < width; x++) {
      const off = y * stride + 1 + x * channels;
      if (channels === 1) gray[y * width + x] = raw[off];
      else {
        gray[y * width + x] = Math.round(0.299 * raw[off] + 0.587 * raw[off + 1] + 0.114 * raw[off + 2]);
      }
    }
  }
  return { width, height, gray, colorType };
}

/** 旋转灰度缓冲（顺时针 90/180/270） */
export function rotateGray(
  g: DecodedGray,
  cw: 90 | 180 | 270,
): { width: number; height: number; gray: Uint8Array } {
  if (cw === 180) {
    const out = new Uint8Array(g.width * g.height);
    for (let y = 0; y < g.height; y++)
      for (let x = 0; x < g.width; x++) out[(g.height - 1 - y) * g.width + (g.width - 1 - x)] = g.gray[y * g.width + x];
    return { width: g.width, height: g.height, gray: out };
  }
  const nw = cw === 90 ? g.height : g.height;
  const nh = cw === 90 ? g.width : g.width;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < g.height; y++) {
    for (let x = 0; x < g.width; x++) {
      const v = g.gray[y * g.width + x];
      if (cw === 90) out[x * nw + (nw - 1 - y)] = v;
      else out[(nh - 1 - x) * nw + y] = v;
    }
  }
  return { width: nw, height: nh, gray: out };
}
