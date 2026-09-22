// 最小 PNG 实现：解码灰度/RGB/RGBA 8-bit（支持全部 5 种行滤波），编码 8-bit 灰度。
import { deflateSync, inflateSync } from 'node:zlib';
import { formatCorrupt } from './errors';

export interface RawImage {
  width: number;
  height: number;
  channels: 1 | 2 | 3 | 4;
  /** 交织前原始字节；灰度取 data[y*width+x]。 */
  data: Uint8Array;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

function readChunks(bytes: Uint8Array): { type: string; data: Uint8Array }[] {
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) formatCorrupt('PNG signature mismatch', [
      { code: 'PNG_BAD_SIGNATURE', severity: 'error', message: '不是 PNG 文件', outcome: 'format-corrupt' }
    ]);
  }
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: { type: string; data: Uint8Array }[] = [];
  let pos = 8;
  while (pos + 8 <= bytes.length) {
    const len = dv.getUint32(pos);
    pos += 4;
    const type = String.fromCharCode(...bytes.slice(pos, pos + 4));
    const data = bytes.slice(pos + 4, pos + 4 + len);
    chunks.push({ type, data });
    pos += 4 + len + 4; // skip CRC
    if (type === 'IEND') break;
  }
  return chunks;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): RawImage {
  const chunks = readChunks(bytes);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  const idat = chunks.filter((c) => c.type === 'IDAT');
  if (!ihdr || idat.length === 0) formatCorrupt('PNG missing IHDR/IDAT');
  const dv = new DataView(ihdr.data.buffer, ihdr.data.byteOffset, ihdr.data.byteLength);
  const width = dv.getUint32(0);
  const height = dv.getUint32(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8 || interlace !== 0)
    formatCorrupt(`Unsupported PNG bitDepth=${bitDepth} interlace=${interlace}`, [
      { code: 'PNG_UNSUPPORTED', severity: 'error', message: '仅支持 8-bit、非交织 PNG', outcome: 'format-corrupt' }
    ]);
  const channels = (colorType === 0 ? 1 : colorType === 4 ? 2 : colorType === 2 ? 3 : colorType === 6 ? 4 : 0) as 1 | 2 | 3 | 4;
  if (!channels) formatCorrupt(`Unsupported PNG colorType=${colorType}`);

  const raw = inflateSync(Buffer.concat(idat.map((c) => Buffer.from(c.data))));
  const stride = width * channels;
  const out = new Uint8Array(stride * height);
  let prev = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    const line = new Uint8Array(stride);
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rp++];
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      switch (filter) {
        case 0: line[x] = rawByte; break;
        case 1: line[x] = rawByte + a; break;
        case 2: line[x] = rawByte + b; break;
        case 3: line[x] = rawByte + ((a + b) >> 1); break;
        case 4: line[x] = rawByte + paeth(a, b, c); break;
        default: formatCorrupt(`Bad PNG filter ${filter}`);
      }
    }
    out.set(line, y * stride);
    prev = line;
  }
  return { width, height, channels, data: out };
}

/** 取 0..255 灰度（暗条带在亮胶上：合成器直接输出“反色后强度”，见 synthesize）。 */
export function toGray(img: RawImage): { gray: Uint8Array; inverted: Uint8Array } {
  const gray = new Uint8Array(img.width * img.height);
  const inverted = new Uint8Array(img.width * img.height);
  for (let i = 0; i < gray.length; i++) {
    let g: number;
    if (img.channels === 1 || img.channels === 2) g = img.data[i * img.channels];
    else {
      const o = i * img.channels;
      g = Math.round(0.299 * img.data[o] + 0.587 * img.data[o + 1] + 0.114 * img.data[o + 2]);
    }
    gray[i] = g;
    inverted[i] = 255 - g;
  }
  return { gray, inverted };
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
const CRC_TABLE = crcTable();
function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  out.set(Buffer.from(type, 'ascii'), 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.slice(4, 8 + data.length)));
  return out;
}

export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // filter byte 0 per scanline
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  const idat = deflateSync(Buffer.from(raw), { level: 6 });
  const sig = Uint8Array.from(PNG_SIG);
  const total = sig.length + 12 + 13 + 12 + idat.length + 12;
  const out = new Uint8Array(total);
  let off = 0;
  const put = (b: Uint8Array) => { out.set(b, off); off += b.length; };
  put(sig);
  put(chunk('IHDR', ihdr));
  put(chunk('IDAT', Uint8Array.from(idat)));
  put(chunk('IEND', new Uint8Array(0)));
  return out;
}
