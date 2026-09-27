import { deflateSync, inflateSync } from 'node:zlib';

export interface GrayImage {
  width: number;
  height: number;
  /** 0..255 灰度，长度 width*height（0=黑） */
  data: Uint8Array;
}

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

function chunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])), 0);
  return Buffer.concat([len, typeBuf, body, crc]);
}

/** 8-bit 灰度 PNG 编码（无外部依赖） */
export function encodeGrayPng(img: GrayImage): Buffer {
  if (img.data.length !== img.width * img.height) throw new Error('灰度数据尺寸不符');
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(img.width, 0);
  ihdr.writeUInt32BE(img.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  const stride = img.width;
  const raw = Buffer.alloc((stride + 1) * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * (stride + 1)] = 0; // filter none
    img.data.subarray ? raw.set(img.data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1)
      : Buffer.from(img.data.slice(y * stride, (y + 1) * stride)).copy(raw, y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

export class PngFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngFormatError';
  }
}

/** PNG 解码 -> 灰度。支持灰度(0)/RGB(2)/调色板(3)/RGBA(6)，8/16-bit（降采样）。 */
export function decodePngToGray(buf: Buffer): GrayImage {
  if (buf.length < 8 || buf.readUInt32BE(0) !== 0x89504e47) throw new PngFormatError('缺少 PNG 签名');
  let offset = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = -1;
  const idat: Buffer[] = [];
  let palette: Uint8Array | null = null;
  while (offset < buf.length) {
    if (offset + 8 > buf.length) throw new PngFormatError('数据块头部被截断');
    const len = buf.readUInt32BE(offset);
    const type = buf.toString('ascii', offset + 4, offset + 8);
    const start = offset + 8;
    if (start + len > buf.length) throw new PngFormatError(`数据块 ${type} 越界`);
    const body = buf.subarray(start, start + len);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0); height = body.readUInt32BE(4);
      bitDepth = body[8]; colorType = body[9];
    } else if (type === 'PLTE') {
      palette = new Uint8Array(body);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    offset = start + len + 4;
  }
  if (!width || !height) throw new PngFormatError('缺少 IHDR');
  const inflated = inflateSync(Buffer.concat(idat));
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : colorType === 6 ? 4 : 0;
  if (!channels) throw new PngFormatError(`不支持的 colorType=${colorType}`);
  const bytesPerSample = bitDepth === 16 ? 2 : 1;
  const supportedBits = bitDepth === 8 || bitDepth === 16 || (colorType === 0 && (bitDepth === 1 || bitDepth === 2 || bitDepth === 4));
  if (!supportedBits) throw new PngFormatError(`不支持的 bitDepth=${bitDepth}`);
  const samplesPerLine = width * channels;
  const rawBytesPerLine = (samplesPerLine * bitDepth + 7) >> 3;
  const data = new Uint8Array(width * height);
  let pos = 0;
  const prev = new Uint8Array(rawBytesPerLine);
  const line = new Uint8Array(rawBytesPerLine);
  for (let y = 0; y < height; y++) {
    if (pos >= inflated.length) throw new PngFormatError('IDAT 扫描线缺失');
    const filter = inflated[pos++];
    if (pos + rawBytesPerLine > inflated.length) throw new PngFormatError('扫描线被截断');
    line.set(inflated.subarray(pos, pos + rawBytesPerLine));
    pos += rawBytesPerLine;
    if (filter === 1) for (let i = channels * bytesPerSample; i < rawBytesPerLine; i++) line[i] = (line[i] + line[i - channels * bytesPerSample]) & 255;
    else if (filter === 2) for (let i = 0; i < rawBytesPerLine; i++) line[i] = (line[i] + prev[i]) & 255;
    else if (filter === 3) for (let i = 0; i < rawBytesPerLine; i++) { const a = i >= channels * bytesPerSample ? line[i - channels * bytesPerSample] : 0; line[i] = (line[i] + ((a + prev[i]) >> 1)) & 255; }
    else if (filter === 4) for (let i = 0; i < rawBytesPerLine; i++) { const a = i >= channels * bytesPerSample ? line[i - channels * bytesPerSample] : 0; const b = prev[i]; const c = i >= channels * bytesPerSample ? prev[i - channels * bytesPerSample] : 0; const p = a + b - c; const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); line[i] = (line[i] + (pa <= pb && pa <= pc ? a : pb <= pc ? b : c)) & 255; }
    else if (filter !== 0) throw new PngFormatError(`未知滤波器 ${filter}`);
    for (let x = 0; x < width; x++) {
      let g: number;
      if (colorType === 3) {
        const idx = line[x];
        g = palette ? palette[idx * 3] : 0;
      } else {
        const sIdx = x * channels * bytesPerSample;
        if (bitDepth === 16) g = line[sIdx] >> 0; // 高字节已可作灰度近似
        else if (bitDepth === 8) g = channels >= 3 ? Math.round(0.299 * line[sIdx] + 0.587 * line[sIdx + 1] + 0.114 * line[sIdx + 2]) : line[sIdx];
        else {
          // 1/2/4-bit 灰度：右对齐取值
          const bits = bitDepth;
          const byteIndex = (x * bits) >> 3;
          const shift = 8 - bits - ((x * bits) & (8 - bits));
          const maxV = (1 << bits) - 1;
          g = Math.round(((line[byteIndex] >> shift) & maxV) * (255 / maxV));
        }
      }
      data[y * width + x] = g;
    }
    prev.set(line);
  }
  return { width, height, data };
}

/** 顺时针旋转 90/180/270 度（用于旋转图像反例：输入本身旋转，检测器必须先转正） */
export function rotateGray(img: GrayImage, deg: 0 | 90 | 180 | 270): GrayImage {
  if (deg === 0) return img;
  const { width: w, height: h, data } = img;
  if (deg === 180) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(h - 1 - y) * w + (w - 1 - x)] = data[y * w + x];
    return { width: w, height: h, data: out };
  }
  const cw = deg === 90;
  const out = new Uint8Array(h * w);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const [nx, ny] = cw ? [h - 1 - y, x] : [y, w - 1 - x];
      out[ny * h + nx] = data[y * w + x];
    }
  }
  return { width: h, height: w, data: out };
}
