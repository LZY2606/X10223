import { deflateSync, inflateSync } from 'node:zlib';
import { GelBenchError } from './types';

/**
 * 极简 PNG 编解码（灰度 8-bit，RGB 8-bit）。
 * 仅服务于本工作台合成图像与检测流水线；格式损坏在此处被识别为
 * format-corrupt（与语义无解、预算耗尽严格区分）。
 */

export interface PngImage {
  width: number;
  height: number;
  channels: 1 | 3;
  /** 行优先灰度数据（RGB 输入按 ITU-R BT.601 转灰度），长度 = width*height，值 0..255 */
  gray: Uint8Array;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i++) crc = CRC_TABLE[(crc ^ buf[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBuf = new TextEncoder().encode(type);
  const len = data.length;
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  out.set(typeBuf, 4);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

export function encodePng(
  gray: Uint8Array,
  width: number,
  height: number,
  channels: 1 | 3 = 1
): Uint8Array {
  if (gray.length !== width * height * channels) {
    throw new GelBenchError('format-corrupt', 'PNG 编码：像素缓冲与尺寸不一致');
  }
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = channels === 1 ? 0 : 2;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(gray.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  return concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))]);
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((s, p) => s + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function decodePng(bytes: Uint8Array): PngImage {
  try {
    const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
    for (let i = 0; i < 8; i++) {
      if (bytes[i] !== sig[i]) throw new Error('bad signature');
    }
    let pos = 8;
    let width = 0;
    let height = 0;
    let colorType = -1;
    let bitDepth = 0;
    const idat: Uint8Array[] = [];
    while (pos < bytes.length) {
      if (pos + 8 > bytes.length) throw new Error('truncated chunk header');
      const dv = new DataView(bytes.buffer, bytes.byteOffset + pos);
      const len = dv.getUint32(0);
      const type = new TextDecoder().decode(bytes.subarray(pos + 4, pos + 8));
      const dataStart = pos + 8;
      if (dataStart + len + 4 > bytes.length) throw new Error('truncated chunk data');
      const storedCrc = new DataView(bytes.buffer, bytes.byteOffset + dataStart + len).getUint32(0);
      if (crc32(bytes.subarray(pos + 4, dataStart + len)) !== storedCrc) {
        throw new Error(`crc mismatch in ${type}`);
      }
      const data = bytes.subarray(dataStart, dataStart + len);
      if (type === 'IHDR') {
        const ihdrDv = new DataView(data.buffer, data.byteOffset);
        width = ihdrDv.getUint32(0);
        height = ihdrDv.getUint32(4);
        bitDepth = data[8];
        colorType = data[9];
        if (data[12] !== 0) throw new Error('interlace unsupported');
      } else if (type === 'IDAT') {
        idat.push(data);
      } else if (type === 'IEND') {
        break;
      }
      pos = dataStart + len + 4;
    }
    if (bitDepth !== 8 || (colorType !== 0 && colorType !== 2)) {
      throw new Error(`unsupported bitDepth/colorType ${bitDepth}/${colorType}`);
    }
    const channels = (colorType === 0 ? 1 : 3) as 1 | 3;
    const raw = inflateSync(concat(idat));
    const stride = width * channels;
    const expected = (stride + 1) * height;
    if (raw.length !== expected) throw new Error('decompressed size mismatch');
    const pixels = new Uint8Array(width * height * channels);
    const bpp = channels;
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const srcOff = y * (stride + 1) + 1;
      const dstOff = y * stride;
      for (let x = 0; x < stride; x++) {
        const cur = raw[srcOff + x];
        const left = x >= bpp ? pixels[dstOff + x - bpp] : 0;
        const up = y > 0 ? pixels[dstOff - stride + x] : 0;
        const upLeft = y > 0 && x >= bpp ? pixels[dstOff - stride + x - bpp] : 0;
        let v = cur;
        if (filter === 1) v = cur + left;
        else if (filter === 2) v = cur + up;
        else if (filter === 3) v = cur + ((left + up) >> 1);
        else if (filter === 4) v = cur + paeth(left, up, upLeft);
        else if (filter !== 0) throw new Error(`bad filter ${filter}`);
        pixels[dstOff + x] = v & 0xff;
      }
    }
    const gray = new Uint8Array(width * height);
    if (channels === 1) gray.set(pixels);
    else {
      for (let i = 0; i < width * height; i++) {
        gray[i] = Math.round(0.299 * pixels[3 * i] + 0.587 * pixels[3 * i + 1] + 0.114 * pixels[3 * i + 2]);
      }
    }
    return { width, height, channels, gray };
  } catch (err) {
    throw new GelBenchError(
      'format-corrupt',
      `PNG 解析失败（格式损坏）：${(err as Error).message}`,
      [{ code: 'UNCONVERTIBLE_VALUE', message: (err as Error).message, location: null }]
    );
  }
}
