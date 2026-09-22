import { deflateSync, inflateSync, crc32 } from 'node:zlib';

/**
 * 最小 8-bit 灰度 PNG 编解码：只依赖 node:zlib，案例包图像可离线生成/读回。
 * 像素布局为逐行 Uint8Array（0=黑，255=白）。
 */

const PNG_SIGNATURE = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10]);

function u32be(value: number): Uint8Array {
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value >>> 0);
  return out;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = new TextEncoder().encode(type);
  const len = u32be(data.length);
  const body = new Uint8Array(typeBytes.length + data.length);
  body.set(typeBytes, 0);
  body.set(data, typeBytes.length);
  const checksum = u32be(crc32(body) >>> 0);
  const out = new Uint8Array(4 + body.length + 4);
  out.set(len, 0);
  out.set(body, 4);
  out.set(checksum, 4 + body.length);
  return out;
}

export interface GrayImage {
  width: number;
  height: number;
  /** 逐行灰度，长度 width*height，约定：值越大越亮 */
  pixels: Uint8Array;
}

export function encodePngGray(image: GrayImage): Uint8Array {
  if (image.pixels.length !== image.width * image.height) {
    throw new Error('PNG_ENCODE_SIZE_MISMATCH');
  }
  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, image.width);
  view.setUint32(4, image.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 = grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = image.width + 1;
  const raw = new Uint8Array(stride * image.height);
  for (let y = 0; y < image.height; y += 1) {
    raw[y * stride] = 0; // filter type none
    raw.set(image.pixels.subarray(y * image.width, (y + 1) * image.width), y * stride + 1);
  }
  const idat = deflateSync(raw, { level: 9 });

  const parts = [PNG_SIGNATURE, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', new Uint8Array(0))];
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

function readChunks(bytes: Uint8Array): { type: string; data: Uint8Array }[] {
  for (let i = 0; i < 8; i += 1) {
    if (bytes[i] !== PNG_SIGNATURE[i]) throw new Error('PNG_CORRUPT_SIGNATURE');
  }
  const chunks: { type: string; data: Uint8Array }[] = [];
  let offset = 8;
  while (offset + 8 <= bytes.length) {
    const view = new DataView(bytes.buffer, bytes.byteOffset);
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(bytes.subarray(offset + 4, offset + 8));
    const dataStart = offset + 8;
    const dataEnd = dataStart + length;
    if (dataEnd + 4 > bytes.length) throw new Error('PNG_CORRUPT_TRUNCATED_CHUNK');
    chunks.push({ type, data: bytes.subarray(dataStart, dataEnd) });
    offset = dataEnd + 4;
    if (type === 'IEND') break;
  }
  return chunks;
}

export function decodePngGray(bytes: Uint8Array): GrayImage {
  const chunks = readChunks(bytes);
  const ihdr = chunks.find((c) => c.type === 'IHDR');
  const idat = chunks.find((c) => c.type === 'IDAT');
  if (!ihdr || !idat) throw new Error('PNG_CORRUPT_MISSING_CHUNK');
  if (ihdr.data.length < 13) throw new Error('PNG_CORRUPT_IHDR');
  const view = new DataView(ihdr.data.buffer, ihdr.data.byteOffset);
  const width = view.getUint32(0);
  const height = view.getUint32(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  if (colorType !== 0 || bitDepth !== 8) throw new Error('PNG_UNSUPPORTED_COLOR_OR_DEPTH');

  const inflated = inflateSync(idat.data);
  const stride = width + 1;
  if (inflated.length !== stride * height) throw new Error('PNG_CORRUPT_RAW_SIZE');
  const pixels = new Uint8Array(width * height);
  let prevRow = new Uint8Array(width);
  for (let y = 0; y < height; y += 1) {
    const filter = inflated[y * stride];
    const row = inflated.slice(y * stride + 1, (y + 1) * stride);
    if (filter === 1) {
      for (let x = 0; x < width; x += 1) row[x] = (row[x] + (x >= 1 ? row[x - 1] : 0)) & 255;
    } else if (filter === 2) {
      for (let x = 0; x < width; x += 1) row[x] = (row[x] + prevRow[x]) & 255;
    } else if (filter === 3) {
      for (let x = 0; x < width; x += 1) {
        const left = x >= 1 ? row[x - 1] : 0;
        row[x] = (row[x] + Math.floor((left + prevRow[x]) / 2)) & 255;
      }
    } else if (filter === 4) {
      for (let x = 0; x < width; x += 1) {
        const left = x >= 1 ? row[x - 1] : 0;
        const up = prevRow[x];
        const upLeft = x >= 1 ? prevRow[x - 1] : 0;
        const p = left + up - upLeft;
        const pa = Math.abs(p - left);
        const pb = Math.abs(p - up);
        const pc = Math.abs(p - upLeft);
        const pred = pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft;
        row[x] = (row[x] + pred) & 255;
      }
    } else if (filter !== 0) {
      throw new Error('PNG_UNSUPPORTED_FILTER');
    }
    pixels.set(row, y * width);
    prevRow = row;
  }
  return { width, height, pixels };
}

/** 顺时针旋转 90/180/270，返回新像素缓冲（用于“旋转图像”场景） */
export function rotateGray(image: GrayImage, deg: 0 | 90 | 180 | 270): GrayImage {
  if (deg === 0) return image;
  const out = new Uint8Array(image.pixels.length);
  if (deg === 180) {
    for (let y = 0; y < image.height; y += 1) {
      for (let x = 0; x < image.width; x += 1) {
        out[(image.height - 1 - y) * image.width + (image.width - 1 - x)] =
          image.pixels[y * image.width + x];
      }
    }
    return { width: image.width, height: image.height, pixels: out };
  }
  const width = image.height;
  const height = image.width;
  const rotated = new Uint8Array(width * height);
  for (let y = 0; y < image.height; y += 1) {
    for (let x = 0; x < image.width; x += 1) {
      const v = image.pixels[y * image.width + x];
      if (deg === 90) rotated[x * width + (width - 1 - y)] = v;
      else rotated[(height - 1 - x) * width + y] = v;
    }
  }
  return { width, height, pixels: rotated };
}

export function samplePixel(image: GrayImage, x: number, y: number): number {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= image.width || yi >= image.height) return 0;
  return image.pixels[yi * image.width + xi];
}
