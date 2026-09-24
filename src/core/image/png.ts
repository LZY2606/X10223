import { deflateSync, inflateSync } from 'node:zlib';
import { Buffer } from 'node:buffer';
import { CorruptFormatError, diag } from '../diagnostic';
import type { RawImage } from './types';

// 最小可用 PNG：编码使用 colorType 0（8-bit 灰度）；解码支持 0/2/6，全部 filter。
const SIG = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);

function crc32(buf: Buffer): number {
  let c: number;
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]) & 0xff;
    crc = (crc >>> 8) ^ table[c];
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let _table: Uint32Array | undefined;
function crcTable(): Uint32Array {
  if (_table) return _table;
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  _table = t;
  return t;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

export function encodeGrayPng(width: number, height: number, gray: Buffer | Uint8Array): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type gray
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    gray.subarray(y * stride, (y + 1) * stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  return Buffer.concat([
    SIG,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

function unfilter(raw: Buffer, width: number, height: number, bpp: number): Buffer {
  const stride = width * bpp;
  const out = Buffer.alloc(stride * height);
  let pos = 0;
  for (let y = 0; y < height; y++) {
    const f = raw[pos++];
    const rowStart = y * stride;
    const prevStart = (y - 1) * stride;
    for (let x = 0; x < stride; x++) {
      const cur = raw[pos++];
      const a = x >= bpp ? out[rowStart + x - bpp] : 0;
      const b = y > 0 ? out[prevStart + x] : 0;
      const c = y > 0 && x >= bpp ? out[prevStart + x - bpp] : 0;
      let v: number;
      switch (f) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = cur + pr;
          break;
        }
        default:
          throw new CorruptFormatError([
            diag('PNG_BAD_FILTER', 'corrupt-format', `不支持的 PNG filter 类型 ${f}`)
          ]);
      }
      out[rowStart + x] = v & 0xff;
    }
  }
  return out;
}

export function decodePng(bytes: Buffer): RawImage {
  if (bytes.length < 8 || !bytes.subarray(0, 8).equals(SIG)) {
    throw new CorruptFormatError([diag('PNG_BAD_SIG', 'corrupt-format', '不是 PNG 文件（签名不匹配）')]);
  }
  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  const idat: Buffer[] = [];
  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) {
      throw new CorruptFormatError([diag('PNG_TRUNCATED_CHUNK', 'corrupt-format', 'PNG 数据块被截断', { field: 'chunk-header' })]);
    }
    const len = bytes.readUInt32BE(pos);
    const type = bytes.toString('ascii', pos + 4, pos + 8);
    const dataStart = pos + 8;
    if (dataStart + len + 4 > bytes.length) {
      throw new CorruptFormatError([diag('PNG_TRUNCATED_BODY', 'corrupt-format', `数据块 ${type} 长度超出文件`, { field: type })]);
    }
    const data = bytes.subarray(dataStart, dataStart + len);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[10] !== 0 || data[11] !== 0) {
        throw new CorruptFormatError([diag('PNG_UNSUPPORTED_COMPRESSION', 'corrupt-format', '仅支持 deflate/标准 PNG')]);
      }
      interlace = data[12];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') break;
    pos = dataStart + len + 4;
  }
  if (!width || !height) {
    throw new CorruptFormatError([diag('PNG_NO_IHDR', 'corrupt-format', '缺少 IHDR')]);
  }
  if (interlace !== 0) {
    throw new CorruptFormatError([diag('PNG_INTERLACED', 'corrupt-format', '不支持 Adam7 隔行 PNG')]);
  }
  if (bitDepth !== 8 || ![0, 2, 6].includes(colorType)) {
    throw new CorruptFormatError([
      diag('PNG_UNSUPPORTED_FORMAT', 'corrupt-format', `仅支持 8-bit 灰度/RGB/RGBA（收到 bitDepth=${bitDepth}, colorType=${colorType}）`)
    ]);
  }
  let unfiltered: Buffer;
  try {
    unfiltered = unfilter(inflateSync(Buffer.concat(idat)), width, height, colorType === 0 ? 1 : colorType === 2 ? 3 : 4);
  } catch (e) {
    if (e instanceof CorruptFormatError) throw e;
    throw new CorruptFormatError([diag('PNG_INFLATE_FAIL', 'corrupt-format', 'IDAT 解压失败')]);
  }
  const channels = (colorType === 0 ? 1 : colorType === 2 ? 3 : 4) as 1 | 3 | 4;
  return { width, height, channels, data: unfiltered };
}

// 任意通道 -> 灰度（暗带分析）
export function toGray(img: RawImage): Buffer {
  if (img.channels === 1) return Buffer.from(img.data);
  const { width, height, channels, data } = img;
  const out = Buffer.alloc(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * channels], g = data[i * channels + 1], b = data[i * channels + 2];
    out[i] = Math.round(0.299 * r + 0.587 * g + 0.114 * b);
  }
  return out;
}
