import { deflateSync, inflateSync } from "node:zlib";

export class CorruptImageError extends Error {
  readonly outcome = "corrupt" as const;
  constructor(
    message: string,
    readonly position?: { offset: number; chunk?: string },
  ) {
    super(message);
    this.name = "CorruptImageError";
  }
}

export interface RasterImage {
  width: number;
  height: number;
  /** 0..255 灰度，行优先 */
  gray: Uint8Array;
}

const SIG = [137, 80, 78, 71, 13, 10, 26, 10];

/** 8-bit 灰度 PNG 编码（足够离线案例包使用） */
export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Uint8Array {
  if (gray.length !== width * height) throw new Error("raster size mismatch");
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter: none
    gray.subarray(y * width, (y + 1) * width).forEach((v, i) => {
      raw[y * (width + 1) + 1 + i] = v;
    });
  }
  const chunks: Buffer[] = [Buffer.from(SIG)];
  chunks.push(chunk("IHDR", ihdr(width, height)));
  chunks.push(chunk("IDAT", deflateSync(raw, { level: 6 })));
  chunks.push(chunk("IEND", Buffer.alloc(0)));
  return Buffer.concat(chunks);
}

function ihdr(w: number, h: number): Buffer {
  const b = Buffer.alloc(13);
  b.writeUInt32BE(w, 0);
  b.writeUInt32BE(h, 4);
  b[8] = 8; // bit depth
  b[9] = 0; // color type grayscale
  b[10] = 0;
  b[11] = 0;
  b[12] = 0;
  return b;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
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
  for (const b of buf) c = CRC_TABLE[(c ^ b) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** 解码灰度(0)/真彩(2) 8-bit PNG，无 interlace；签名/CRC/结构错误 → CorruptImageError */
export function decodePng(bytes: Uint8Array): RasterImage {
  const buf = Buffer.from(bytes);
  if (buf.length < 8 + 25) throw new CorruptImageError("file too short", { offset: buf.length });
  for (let i = 0; i < 8; i++) {
    if (buf[i] !== SIG[i]) throw new CorruptImageError("bad PNG signature", { offset: i });
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  let sawIHDR = false;

  while (off < buf.length) {
    if (off + 8 > buf.length) throw new CorruptImageError("truncated chunk header", { offset: off });
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    const dataStart = off + 8;
    const dataEnd = dataStart + len;
    if (dataEnd + 4 > buf.length) throw new CorruptImageError(`truncated chunk ${type}`, { offset: off, chunk: type });
    const storedCrc = buf.readUInt32BE(dataEnd);
    const actualCrc = crc32(buf.subarray(off + 4, dataEnd)) >>> 0;
    if (storedCrc !== actualCrc) throw new CorruptImageError(`CRC mismatch in ${type}`, { offset: dataEnd, chunk: type });
    const data = buf.subarray(dataStart, dataEnd);
    if (type === "IHDR") {
      if (len !== 13) throw new CorruptImageError("bad IHDR length", { offset: off, chunk: type });
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8]!;
      colorType = data[9]!;
      if (bitDepth !== 8) throw new CorruptImageError(`unsupported bit depth ${bitDepth}`, { offset: off + 8 + 8, chunk: type });
      if (colorType !== 0 && colorType !== 2) throw new CorruptImageError(`unsupported color type ${colorType}`, { offset: off + 8 + 9, chunk: type });
      if (data[12] !== 0) throw new CorruptImageError("interlace unsupported", { chunk: type });
      sawIHDR = true;
    } else if (type === "IDAT") {
      if (!sawIHDR) throw new CorruptImageError("IDAT before IHDR", { chunk: type });
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    off = dataEnd + 4;
  }
  if (!sawIHDR || width === 0 || height === 0) throw new CorruptImageError("missing IHDR", { offset: 0 });

  let raw: Buffer;
  try {
    raw = inflateSync(Buffer.concat(idat));
  } catch {
    throw new CorruptImageError("IDAT stream not inflatable", { chunk: "IDAT" });
  }
  const channels = colorType === 0 ? 1 : 3;
  const stride = width * channels;
  if (raw.length !== (stride + 1) * height) throw new CorruptImageError("decompressed size mismatch", { chunk: "IDAT" });

  const gray = new Uint8Array(width * height);
  let prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    const filter = raw[rowStart];
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const x = raw[rowStart + 1 + i]!;
      const a = i >= channels ? cur[i - channels]! : 0;
      const b = prev[i]!;
      const c = i >= channels ? prev[i - channels]! : 0;
      let v: number;
      switch (filter) {
        case 0: v = x; break;
        case 1: v = x + a; break;
        case 2: v = x + b; break;
        case 3: v = x + ((a + b) >> 1); break;
        case 4: {
          const p = a + b - c;
          const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
          const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
          v = x + pr;
          break;
        }
        default:
          throw new CorruptImageError(`bad filter ${filter} at row ${y}`, { offset: rowStart });
      }
      cur[i] = v & 0xff;
    }
    for (let x = 0; x < width; x++) {
      gray[y * width + x] = channels === 1 ? cur[x]! : ((cur[x * 3]! + cur[x * 3 + 1]! + cur[x * 3 + 2]!) / 3) | 0;
    }
    prev = cur;
  }
  return { width, height, gray };
}
