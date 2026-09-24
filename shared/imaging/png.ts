import { deflateSync, inflateSync } from "node:zlib";

export interface RasterImage {
  width: number;
  height: number;
  /** RGBA 8bit，行优先，长度 width*height*4。 */
  data: Uint8Array;
}

const PNG_SIG = [137, 80, 78, 71, 13, 10, 26, 10];

export function decodePng(bytes: Uint8Array): { image: RasterImage; error?: string } {
  try {
    if (bytes.length < 8 || PNG_SIG.some((v, i) => bytes[i] !== v)) {
      return { image: blank(1, 1), error: "png.bad-signature" };
    }
    let pos = 8;
    let width = 0;
    let height = 0;
    let bitDepth = 0;
    let colorType = 0;
    const idat: number[] = [];
    const palettes: number[][] = [];
    let interlace = 0;
    while (pos < bytes.length) {
      const len = readU32(bytes, pos);
      pos += 4;
      const type = String.fromCharCode(bytes[pos], bytes[pos + 1], bytes[pos + 2], bytes[pos + 3]);
      pos += 4;
      const chunk = bytes.subarray(pos, pos + len);
      pos += len + 4;
      if (type === "IHDR") {
        width = readU32(chunk, 0);
        height = readU32(chunk, 4);
        bitDepth = chunk[8]!;
        colorType = chunk[9]!;
        interlace = chunk[12]!;
        if (bitDepth !== 8) return { image: blank(width, height), error: "png.unsupported-bit-depth" };
        if (interlace !== 0) return { image: blank(width, height), error: "png.unsupported-interlace" };
        if (![0, 2, 3, 4, 6].includes(colorType)) return { image: blank(width, height), error: "png.unsupported-color-type" };
      } else if (type === "PLTE") {
        for (let i = 0; i < chunk.length; i += 3) palettes.push([chunk[i]!, chunk[i + 1]!, chunk[i + 2]!]);
      } else if (type === "IDAT") {
        for (const b of chunk) idat.push(b);
      } else if (type === "IEND") {
        break;
      }
    }
    if (!width || !height) return { image: blank(1, 1), error: "png.truncated" };
    const raw = inflateSync(Buffer.from(idat));
    const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 3 ? 1 : colorType === 4 ? 2 : 4;
    const bpp = channels;
    const stride = width * bpp;
    const unfiltered = Buffer.alloc(height * stride);
    let rp = 0;
    for (let y = 0; y < height; y++) {
      const filter = raw[rp++]!;
      const rowStart = y * stride;
      for (let x = 0; x < stride; x++) {
        const rawByte = raw[rp++]!;
        const left = x >= bpp ? unfiltered[rowStart + x - bpp]! : 0;
        const up = y > 0 ? unfiltered[rowStart - stride + x]! : 0;
        const upLeft = y > 0 && x >= bpp ? unfiltered[rowStart - stride + x - bpp]! : 0;
        let v = rawByte;
        if (filter === 1) v = (rawByte + left) & 255;
        else if (filter === 2) v = (rawByte + up) & 255;
        else if (filter === 3) v = (rawByte + ((left + up) >> 1)) & 255;
        else if (filter === 4) v = (rawByte + paeth(left, up, upLeft)) & 255;
        else if (filter !== 0) return { image: blank(width, height), error: "png.bad-filter" };
        unfiltered[rowStart + x] = v;
      }
    }
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
      for (let x = 0; x < width; x++) {
        const si = (y * width + x) * bpp;
        const di = (y * width + x) * 4;
        if (colorType === 0) {
          out[di] = out[di + 1] = out[di + 2] = unfiltered[si]!;
          out[di + 3] = 255;
        } else if (colorType === 2) {
          out[di] = unfiltered[si]!;
          out[di + 1] = unfiltered[si + 1]!;
          out[di + 2] = unfiltered[si + 2]!;
          out[di + 3] = 255;
        } else if (colorType === 3) {
          const pal = palettes[unfiltered[si]!] ?? [0, 0, 0];
          out[di] = pal[0]!;
          out[di + 1] = pal[1]!;
          out[di + 2] = pal[2]!;
          out[di + 3] = 255;
        } else if (colorType === 4) {
          out[di] = out[di + 1] = out[di + 2] = unfiltered[si]!;
          out[di + 3] = unfiltered[si + 1]!;
        } else {
          out[di] = unfiltered[si]!;
          out[di + 1] = unfiltered[si + 1]!;
          out[di + 2] = unfiltered[si + 2]!;
          out[di + 3] = unfiltered[si + 3]!;
        }
      }
    }
    return { image: { width, height, data: out } };
  } catch (e) {
    return { image: blank(1, 1), error: e instanceof Error ? `png.decode-failed:${e.message}` : "png.decode-failed" };
  }
}

function blank(w: number, h: number): RasterImage {
  return { width: w, height: h, data: new Uint8Array(w * h * 4) };
}

function readU32(b: Uint8Array, o: number): number {
  return ((b[o]! << 24) >>> 0) + (b[o + 1]! << 16) + (b[o + 2]! << 8) + b[o + 3]!;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

export function encodePng(image: RasterImage): Uint8Array {
  const { width, height, data } = image;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (stride + 1));
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    data.subarray(y * stride, (y + 1) * stride).forEach((v, i) => {
      raw[y * (stride + 1) + 1 + i] = v;
    });
  }
  const compressed = deflateSync(raw, { level: 6 });
  const chunks: Buffer[] = [Buffer.from(PNG_SIG)];
  chunks.push(makeChunk("IHDR", ihdr(width, height)));
  chunks.push(makeChunk("IDAT", compressed));
  chunks.push(makeChunk("IEND", Buffer.alloc(0)));
  return new Uint8Array(Buffer.concat(chunks));
}

function ihdr(w: number, h: number): Buffer {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0);
  b.writeUInt32BE(h, 4);
  b[8] = 8; // bit depth
  b[9] = 6; // RGBA
  b[10] = 0;
  b[11] = 0;
  b[12] = 0;
  return b;
}

function makeChunk(type: string, body: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, body, crcBuf]);
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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 255]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}
