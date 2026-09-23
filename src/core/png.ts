import { deflateSync, inflateSync } from 'node:zlib';

// 纯 TypeScript PNG 编解码：支持 8-bit gray(0) 与 RGB(2)/RGBA(6)
// 仅用于离线案例包生成与服务端解码，前端使用浏览器原生 canvas/Image。

export interface PngImage {
  width: number;
  height: number;
  channels: 1 | 3 | 4;
  data: Uint8Array;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function crcTable(): Uint32Array {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
}
const CRC_TABLE = crcTable();

function crc32(buf: Uint8Array, start: number, end: number): number {
  let c = 0xffffffff;
  for (let i = start; i < end; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const out = new Uint8Array(12 + len + 4);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  out.set([...type].map((ch) => ch.charCodeAt(0)), 4);
  out.set(data, 8);
  dv.setUint32(8 + len, crc32(out, 4, 8 + len));
  return out;
}

export function encodePng(img: PngImage): Uint8Array {
  const { width, height, channels, data } = img;
  const colorType = channels === 1 ? 0 : channels === 3 ? 2 : 6;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(data.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });

  const parts: Uint8Array[] = [
    Uint8Array.from(PNG_SIG),
    chunk('IHDR', ihdr),
    chunk('IDAT', new Uint8Array(idat)),
    chunk('IEND', new Uint8Array(0)),
  ];
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

export class PngFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngFormatError';
  }
}

export function decodePng(bytes: Uint8Array): PngImage {
  if (bytes.length < 8 || PNG_SIG.some((b, i) => bytes[i] !== b)) {
    throw new PngFormatError('PNG 签名不匹配：格式损坏');
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idatChunks: Uint8Array[] = [];
  while (pos + 8 <= bytes.length) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset + pos);
    const len = dv.getUint32(0);
    const type = String.fromCharCode(bytes[pos + 4], bytes[pos + 5], bytes[pos + 6], bytes[pos + 7]);
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) throw new PngFormatError('PNG 块被截断：格式损坏');
    if (crc32(bytes, pos + 4, dataEnd) !== new DataView(bytes.buffer, bytes.byteOffset + dataEnd).getUint32(0)) {
      throw new PngFormatError('PNG CRC 校验失败：格式损坏');
    }
    if (type === 'IHDR') {
      width = dv.getUint32(8);
      height = dv.getUint32(12);
      bitDepth = bytes[dataStart + 8];
      colorType = bytes[dataStart + 9];
      if (bytes[dataStart + 12] !== 0) throw new PngFormatError('仅支持无隔行 PNG');
    } else if (type === 'IDAT') {
      idatChunks.push(bytes.subarray(dataStart, dataEnd));
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }
  if (!width || !height) throw new PngFormatError('缺少 IHDR：格式损坏');
  if (bitDepth !== 8) throw new PngFormatError(`仅支持 8-bit PNG，收到 ${bitDepth}-bit`);
  if (![0, 2, 6].includes(colorType)) throw new PngFormatError(`不支持的色彩类型 ${colorType}`);
  const channels = (colorType === 0 ? 1 : colorType === 2 ? 3 : 4) as 1 | 3 | 4;
  const inflated = inflateSync(Buffer.concat(idatChunks.map((c) => Buffer.from(c))));
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (inflated.length < expected) throw new PngFormatError('图像数据长度不足：格式损坏');
  const data = new Uint8Array(width * height * channels);
  let src = 0;
  const prev = new Uint8Array(stride);
  const cur = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[src++];
    for (let x = 0; x < stride; x++) cur[x] = inflated[src++];
    switch (filter) {
      case 0:
        break;
      case 1:
        for (let x = channels; x < stride; x++) cur[x] = (cur[x] + cur[x - channels]) & 0xff;
        break;
      case 2:
        for (let x = 0; x < stride; x++) cur[x] = (cur[x] + prev[x]) & 0xff;
        break;
      case 3:
        for (let x = 0; x < stride; x++) {
          const a = x >= channels ? cur[x - channels] : 0;
          cur[x] = (cur[x] + ((a + prev[x]) >> 1)) & 0xff;
        }
        break;
      case 4:
        for (let x = 0; x < stride; x++) {
          const a = x >= channels ? cur[x - channels] : 0;
          const b = prev[x];
          const c = x >= channels ? prev[x - channels] : 0;
          const p = a + b - c;
          const pa = Math.abs(p - a);
          const pb = Math.abs(p - b);
          const pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          cur[x] = (cur[x] + pr) & 0xff;
        }
        break;
      default:
        throw new PngFormatError(`不支持的 PNG 滤波器类型 ${filter}：格式损坏`);
    }
    data.set(cur.subarray(0, stride), y * stride);
    prev.set(cur);
  }
  return { width, height, channels, data };
}

export function toGray(img: PngImage): Uint8Array {
  if (img.channels === 1) return img.data;
  const out = new Uint8Array(img.width * img.height);
  for (let i = 0; i < img.width * img.height; i++) {
    const r = img.data[i * img.channels];
    const g = img.data[i * img.channels + 1];
    const b = img.data[i * img.channels + 2];
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return out;
}
