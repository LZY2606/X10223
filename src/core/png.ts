import { deflateSync, inflateSync, crc32 } from 'node:zlib';

// 最小化 8 位灰度 PNG 编解码。原始凝胶图按未损字节保存，便于像素级溯源。

export interface GrayImage {
  width: number;
  height: number;
  pixels: Uint8Array; // length = width*height, 行优先
  frameId: string;
}

const SIG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function chunk(type: string, data: Uint8Array): Uint8Array {
  const len = data.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  out.set(new TextEncoder().encode(type), 4);
  out.set(data, 8);
  const crc = crc32(
    new Uint8Array(out.buffer, 4, 4 + len)
  );
  dv.setUint32(8 + len, Number(crc) >>> 0);
  return out;
}

export function encodePng(img: GrayImage): Uint8Array {
  if (img.pixels.length !== img.width * img.height) {
    throw new Error('PNG_ENCODE_SIZE_MISMATCH');
  }
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, img.width);
  dv.setUint32(4, img.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = img.width + 1;
  const raw = new Uint8Array(stride * img.height);
  for (let y = 0; y < img.height; y++) {
    raw[y * stride] = 0;
    raw.set(img.pixels.subarray(y * img.width, (y + 1) * img.width), y * stride + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  const parts = [SIG, chunk('IHDR', ihdr), chunk('IDAT', new Uint8Array(idat)), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((n, p) => n + p.length, 0);
  const all = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    all.set(p, off);
    off += p.length;
  }
  return all;
}

export class PngCorruptError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngCorruptError';
  }
}

export function decodePng(bytes: Uint8Array, frameId: string): GrayImage {
  if (bytes.length < 8) throw new PngCorruptError('PNG_TOO_SHORT');
  for (let i = 0; i < 8; i++) {
    if (bytes[i] !== SIG[i]) throw new PngCorruptError('PNG_BAD_SIGNATURE');
  }
  let width = 0;
  let height = 0;
  let idat = new Uint8Array(0);
  let off = 8;
  while (off < bytes.length) {
    if (off + 8 > bytes.length) throw new PngCorruptError('PNG_TRUNCATED_CHUNK_HEADER');
    const dv = new DataView(bytes.buffer, bytes.byteOffset + off, 8);
    const len = dv.getUint32(0);
    const type = new TextDecoder().decode(bytes.subarray(off + 4, off + 8));
    const dataStart = off + 8;
    if (dataStart + len + 4 > bytes.length) throw new PngCorruptError('PNG_TRUNCATED_CHUNK_DATA');
    const data = bytes.subarray(dataStart, dataStart + len);
    if (type === 'IHDR') {
      if (len < 13) throw new PngCorruptError('PNG_BAD_IHDR');
      const iv = new DataView(data.buffer, data.byteOffset, 13);
      width = iv.getUint32(0);
      height = iv.getUint32(4);
      if (data[8] !== 8 || data[9] !== 0) throw new PngCorruptError('PNG_UNSUPPORTED_FORMAT: only grayscale 8-bit');
    } else if (type === 'IDAT') {
      const merged = new Uint8Array(idat.length + data.length);
      merged.set(idat, 0);
      merged.set(data, idat.length);
      idat = merged;
    } else if (type === 'IEND') {
      break;
    }
    off = dataStart + len + 4;
  }
  if (!width || !height) throw new PngCorruptError('PNG_MISSING_DIMENSIONS');
  let inflated: Uint8Array;
  try {
    inflated = new Uint8Array(inflateSync(idat));
  } catch {
    throw new PngCorruptError('PNG_BAD_IDAT');
  }
  const stride = width + 1;
  if (inflated.length !== stride * height) throw new PngCorruptError('PNG_RASTER_SIZE_MISMATCH');
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * stride];
    if (filter !== 0) throw new PngCorruptError('PNG_UNSUPPORTED_FILTER');
    pixels.set(inflated.subarray(y * stride + 1, y * stride + 1 + width), y * width);
  }
  return { width, height, pixels, frameId };
}
