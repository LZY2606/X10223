// 极简 PNG 编解码（离线、零图像依赖）。
// 解码支持 8 位灰度(0)/RGB(2)/RGBA(6)；编码输出 8 位灰度(0)。
import { deflateSync, inflateSync } from 'node:zlib';
import { D, diag } from '../../shared/diagnostics.js';
import type { Diagnostic } from '../../shared/types.js';

export interface GrayImage {
  width: number;
  height: number;
  /** 行优先灰度 0..255（255=白） */
  gray: Uint8Array;
  /** 原始解包后的 RGBA（可选，用于浏览器直接展示彩色合成） */
  rgba: Uint8ClampedArray;
}

const PNG_SIG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(
  bytes: Uint8Array,
): { ok: true; image: GrayImage } | { ok: false; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  if (bytes.length < 8 + 12) {
    return {
      ok: false,
      diagnostics: [diag(D.FORMAT_PNG_CORRUPT, 'error', 'PNG 数据过短', '/bytes')],
    };
  }
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== PNG_SIG[i]) {
      return {
        ok: false,
        diagnostics: [diag(D.FORMAT_PNG_CORRUPT, 'error', 'PNG 签名错误', '/bytes/0')],
      };
    }
  }
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: number[] = [];
  let pos = 8;
  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) {
      return {
        ok: false,
        diagnostics: [diag(D.FORMAT_PNG_CORRUPT, 'error', 'PNG chunk 长度损坏', `/bytes/${pos}`)],
      };
    }
    const len = readU32(bytes, pos);
    const type = String.fromCharCode(...bytes.subarray(pos + 4, pos + 8));
    const dataStart = pos + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > bytes.length) {
      return {
        ok: false,
        diagnostics: [diag(D.FORMAT_PNG_CORRUPT, 'error', `chunk ${type} 被截断`, `/bytes/${pos}`)],
      };
    }
    if (type === 'IHDR') {
      width = readU32(bytes, dataStart);
      height = readU32(bytes, dataStart + 4);
      bitDepth = bytes[dataStart + 8]!;
      colorType = bytes[dataStart + 9]!;
      if (bitDepth !== 8 || ![0, 2, 6].includes(colorType)) {
        return {
          ok: false,
          diagnostics: [
            diag(
              D.FORMAT_UNSUPPORTED,
              'error',
              `仅支持 8 位灰度/RGB/RGBA，实际 bitDepth=${bitDepth} colorType=${colorType}`,
              '/IHDR',
            ),
          ],
        };
      }
    } else if (type === 'IDAT') {
      for (let i = dataStart; i < dataEnd; i++) idat.push(bytes[i]!);
    } else if (type === 'IEND') {
      break;
    }
    pos = dataEnd + 4;
  }
  if (!width || !height) {
    return {
      ok: false,
      diagnostics: [diag(D.FORMAT_PNG_CORRUPT, 'error', '缺少 IHDR', '/IHDR')],
    };
  }
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : 4;
  let raw: Uint8Array;
  try {
    raw = inflateSync(Uint8Array.from(idat));
  } catch {
    return {
      ok: false,
      diagnostics: [diag(D.FORMAT_PNG_CORRUPT, 'error', 'IDAT zlib 解压失败', '/IDAT')],
    };
  }
  const stride = width * channels;
  if (raw.length !== height * (stride + 1)) {
    return {
      ok: false,
      diagnostics: [
        diag(
          D.FORMAT_PNG_CORRUPT,
          'error',
          `解压后长度 ${raw.length} 与期望 ${height * (stride + 1)} 不符`,
          '/IDAT',
          { actual: raw.length, expected: height * (stride + 1) },
        ),
      ],
    };
  }
  const gray = new Uint8Array(width * height);
  const rgba = new Uint8ClampedArray(width * height * 4);
  const prev = new Uint8Array(stride);
  const row = new Uint8Array(stride);
  let rp = 0;
  for (let y = 0; y < height; y++) {
    const filter = raw[rp]!;
    rp++;
    for (let x = 0; x < stride; x++) {
      const cur = raw[rp]!;
      rp++;
      const a = x >= channels ? row[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = cur; break;
        case 1: v = cur + a; break;
        case 2: v = cur + b; break;
        case 3: v = cur + ((a + b) >> 1); break;
        case 4: v = cur + paeth(a, b, c); break;
        default:
          return {
            ok: false,
            diagnostics: [diag(D.FORMAT_PNG_CORRUPT, 'error', `未知滤波 ${filter}`, `/rows/${y}`)],
          };
      }
      row[x] = v & 255;
    }
    for (let x = 0; x < width; x++) {
      let r: number;
      let g: number;
      let bl: number;
      if (channels === 1) {
        r = g = bl = row[x]!;
      } else {
        r = row[x * channels]!;
        g = row[x * channels + 1]!;
        bl = row[x * channels + 2]!;
      }
      const idx = y * width + x;
      gray[idx] = (0.299 * r + 0.587 * g + 0.114 * bl) | 0;
      const ri = idx * 4;
      rgba[ri] = r;
      rgba[ri + 1] = g;
      rgba[ri + 2] = bl;
      rgba[ri + 3] = channels === 4 ? row[x * 4 + 3]! : 255;
    }
    prev.set(row);
  }
  return { ok: true, image: { width, height, gray, rgba } };
}

// ---- 编码 -------------------------------------------------------------------
function crc32(buf: Uint8Array): number {
  let c: number;
  const table = crcTable();
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = (crc ^ buf[i]!) & 0xff;
    crc = (crc >>> 8) ^ table[c]!;
  }
  return (crc ^ 0xffffffff) >>> 0;
}

let cachedTable: Uint32Array | undefined;
function crcTable(): Uint32Array {
  if (cachedTable) return cachedTable;
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  cachedTable = table;
  return table;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  writeU32(out, 0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  const crcInput = new Uint8Array(4 + data.length);
  for (let i = 0; i < 4; i++) crcInput[i] = type.charCodeAt(i);
  crcInput.set(data, 4);
  writeU32(out, 8 + data.length, crc32(crcInput));
  return out;
}

export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Uint8Array {
  const ihdr = new Uint8Array(13);
  writeU32(ihdr, 0, width);
  writeU32(ihdr, 4, height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = new Uint8Array(height * (width + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter none
    raw.set(gray.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const idat = new Uint8Array(deflateSync(raw, { level: 6 }));
  const total = 8 + 12 + 13 + 12 + idat.length + 12;
  const out = new Uint8Array(total);
  out.set(PNG_SIG, 0);
  let off = 8;
  const a = chunk('IHDR', ihdr);
  out.set(a, off);
  off += a.length;
  const b = chunk('IDAT', idat);
  out.set(b, off);
  off += b.length;
  out.set(chunk('IEND', new Uint8Array(0)), off);
  return out;
}

function readU32(buf: Uint8Array, at: number): number {
  return (
    (buf[at]! * 0x1000000 + (buf[at + 1]! << 16) + (buf[at + 2]! << 8) + buf[at + 3]!) >>>
    0
  );
}

function writeU32(buf: Uint8Array, at: number, value: number): void {
  buf[at] = (value >>> 24) & 255;
  buf[at + 1] = (value >>> 16) & 255;
  buf[at + 2] = (value >>> 8) & 255;
  buf[at + 3] = value & 255;
}
