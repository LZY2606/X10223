/**
 * 最小离线 PNG（8-bit 灰度 / RGB24）编解码，无第三方图像库。
 * 扫描线过滤器仅支持 type 0（None），编码器恒以 None 输出。
 */
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
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export interface GrayImage {
  width: number;
  height: number;
  /** 0..255 灰度，行优先 */
  data: Uint8Array;
}

export function encodeGrayPng(img: GrayImage): Buffer {
  const { width, height, data } = img;
  if (data.length !== width * height) throw new Error('image size mismatch');
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
    raw[y * (stride + 1)] = 0;
    data.copy ? Buffer.from(data).copy(raw, y * (stride + 1) + 1, y * stride, y * stride + stride)
      : raw.set(data.subarray(y * stride, y * stride + stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

export function decodePngToGray(buf: Buffer): GrayImage {
  if (buf.length < 8 || buf.toString('ascii', 1, 4) !== 'PNG') {
    throw new Error('CORRUPT_NOT_PNG');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let depth = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (pos < buf.length) {
    if (pos + 8 > buf.length) throw new Error('CORRUPT_TRUNCATED_CHUNK');
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (dataStart + len + 4 > buf.length) throw new Error('CORRUPT_TRUNCATED_DATA');
    const data = buf.subarray(dataStart, dataStart + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      depth = data[8];
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataStart + len + 4;
  }
  if (colorType !== 0 && colorType !== 2) throw new Error('UNSUPPORTED_COLOR_TYPE');
  if (depth !== 8) throw new Error('UNSUPPORTED_DEPTH');
  const channels = colorType === 0 ? 1 : 3;
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const out = new Uint8Array(width * height);
  let src = 0;
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    if (filter !== 0) throw new Error('UNSUPPORTED_FILTER');
    for (let x = 0; x < width; x++) {
      if (channels === 1) {
        out[y * width + x] = inflated[src++];
      } else {
        const r = inflated[src++];
        const g = inflated[src++];
        const b = inflated[src++];
        out[y * width + x] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
      }
    }
  }
  return { width, height, data: out };
}

/** 像素几何原语：在灰度缓冲上画高斯形暗带（电泳图像背景亮、带暗） */
export function stampBand(
  img: GrayImage,
  cx: number,
  cy: number,
  rx: number,
  ry: number,
  darkness: number
): void {
  const { width: w, height: h, data } = img;
  const x0 = Math.max(0, Math.floor(cx - rx * 3));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx * 3));
  const y0 = Math.max(0, Math.floor(cy - ry * 3));
  const y1 = Math.min(h - 1, Math.ceil(cy + ry * 3));
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / rx;
      const dy = (y - cy) / ry;
      const g = Math.exp(-0.5 * (dx * dx + dy * dy));
      const idx = y * w + x;
      data[idx] = Math.max(0, Math.min(255, Math.round(data[idx] - darkness * g)));
    }
  }
}

/** 竖向拖尾：从带中心向下方渐变扩散 */
export function stampSmear(
  img: GrayImage,
  cx: number,
  cy: number,
  rx: number,
  tail: number,
  darkness: number
): void {
  const { width: w, height: h, data } = img;
  const x0 = Math.max(0, Math.floor(cx - rx * 2));
  const x1 = Math.min(w - 1, Math.ceil(cx + rx * 2));
  const y1 = Math.min(h - 1, Math.floor(cy + tail));
  for (let y = Math.max(0, Math.floor(cy)); y <= y1; y++) {
    const t = (y - cy) / tail;
    const spread = rx * (1 + t * 1.5);
    for (let x = x0; x <= x1; x++) {
      const dx = (x - cx) / spread;
      const g = Math.exp(-0.5 * dx * dx) * (1 - t) * 0.6;
      const idx = y * w + x;
      data[idx] = Math.max(0, Math.min(255, Math.round(data[idx] - darkness * g)));
    }
  }
}
