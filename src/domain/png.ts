import { deflateSync, inflateSync } from "node:zlib";
import { FormatCorruptError } from "./errors.js";

export interface Raster {
  width: number;
  height: number;
  /** 灰度 0..255，行优先 */
  pixels: Uint8Array;
}

const SIGNATURE = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a
]);

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, "ascii");
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 只输出 8-bit 灰度 PNG（领域图像即单通道荧光/灰度） */
export function encodePng(raster: Raster): Buffer {
  if (
    raster.width <= 0 ||
    raster.height <= 0 ||
    raster.pixels.length !== raster.width * raster.height
  ) {
    throw new FormatCorruptError("raster 尺寸与像素数不一致");
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(raster.width, 0);
  ihdr.writeUInt32BE(raster.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type: grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = raster.width + 1;
  const raw = Buffer.alloc(stride * raster.height);
  for (let y = 0; y < raster.height; y++) {
    raw[y * stride] = 0; // filter: none
    raw.set(
      raster.pixels.subarray(y * raster.width, (y + 1) * raster.width),
      y * stride + 1
    );
  }
  return Buffer.concat([
    SIGNATURE,
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 6 })),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

function readChunks(buf: Buffer): { type: string; data: Buffer }[] {
  if (buf.length < 8 + 12 + 12) {
    throw new FormatCorruptError("PNG 过短，缺少必要块");
  }
  if (!buf.subarray(0, 8).equals(SIGNATURE)) {
    throw new FormatCorruptError("PNG 签名错误（offset 0..7）");
  }
  const chunks: { type: string; data: Buffer }[] = [];
  let off = 8;
  let sawIend = false;
  while (off < buf.length) {
    if (off + 8 > buf.length) {
      throw new FormatCorruptError(`块长度截断于 offset ${off}`);
    }
    const len = buf.readUInt32BE(off);
    const type = buf.toString("ascii", off + 4, off + 8);
    if (off + 12 + len > buf.length) {
      throw new FormatCorruptError(`块 ${type} 数据截断于 offset ${off}`);
    }
    const data = buf.subarray(off + 8, off + 8 + len);
    const expectCrc = buf.readUInt32BE(off + 8 + len);
    if (crc32(Buffer.concat([Buffer.from(type, "ascii"), data])) !== expectCrc) {
      throw new FormatCorruptError(`块 ${type} CRC 校验失败于 offset ${off}`);
    }
    chunks.push({ type, data: Buffer.from(data) });
    off += 12 + len;
    if (type === "IEND") {
      sawIend = true;
      break;
    }
  }
  if (!sawIend) throw new FormatCorruptError("缺少 IEND 块");
  return chunks;
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

export function decodePng(bytes: Uint8Array | Buffer): Raster {
  const buf = Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes);
  const chunks = readChunks(buf);
  const ihdr = chunks.find((c) => c.type === "IHDR");
  if (!ihdr || ihdr.data.length < 13) {
    throw new FormatCorruptError("缺少 IHDR 块");
  }
  const width = ihdr.data.readUInt32BE(0);
  const height = ihdr.data.readUInt32BE(4);
  const bitDepth = ihdr.data[8];
  const colorType = ihdr.data[9];
  const interlace = ihdr.data[12];
  if (bitDepth !== 8 || colorType !== 0) {
    throw new FormatCorruptError(
      `仅支持 8-bit 灰度 PNG，实际 bitDepth=${bitDepth} colorType=${colorType}`
    );
  }
  if (interlace !== 0) {
    throw new FormatCorruptError("不支持隔行扫描 PNG（interlace=1）");
  }
  if (width === 0 || height === 0 || width > 65535 || height > 65535) {
    throw new FormatCorruptError(`非法尺寸 ${width}x${height}`);
  }
  const idat = Buffer.concat(
    chunks.filter((c) => c.type === "IDAT").map((c) => c.data)
  );
  let inflated: Buffer;
  try {
    inflated = inflateSync(idat);
  } catch {
    throw new FormatCorruptError("IDAT zlib 解压失败");
  }
  const stride = width + 1;
  if (inflated.length !== stride * height) {
    throw new FormatCorruptError(
      `解压后字节数 ${inflated.length} 与期望 ${stride * height} 不符`
    );
  }
  const pixels = new Uint8Array(width * height);
  let srcOff = 0;
  let prev = Buffer.alloc(width);
  for (let y = 0; y < height; y++) {
    const filter = inflated[srcOff++];
    const line = Buffer.from(inflated.subarray(srcOff, srcOff + width));
    srcOff += width;
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? line[x - 1] : 0;
      const b = prev[x];
      const c = x > 0 ? prev[x - 1] : 0;
      let v = line[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (fitIs3or4(filter)) {
        if (filter === 3) v += Math.floor((a + b) / 2);
        else v += paeth(a, b, c);
      } else if (filter !== 0) {
        throw new FormatCorruptError(`未知 PNG 行滤波器 ${filter}（行 ${y}）`);
      }
      line[x] = v & 0xff;
      pixels[y * width + x] = line[x];
    }
    prev = line;
  }
  return { width, height, pixels };
}

function fitIs3or4(f: number): boolean {
  return f === 3 || f === 4;
}
