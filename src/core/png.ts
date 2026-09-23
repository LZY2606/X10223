import { deflateSync, inflateSync } from "node:zlib";
import { CorruptFormatError } from "./types.js";

export interface GrayImage {
  width: number;
  height: number;
  channels: 1 | 3;
  /** 长度 width*height*channels，0..255 */
  data: Uint8Array;
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

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]!)!]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function u32(n: number): Uint8Array {
  const b = new Uint8Array(4);
  new DataView(b.buffer).setUint32(0, n >>> 0, false);
  return b;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const len = parts.reduce((a, b) => a + b.length, 0);
  const out = new Uint8Array(len);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const typeB = new TextEncoder().encode(type);
  const crcInput = concat([typeB, body]);
  return concat([u32(body.length), typeB, body, u32(crc32(crcInput))]);
}

/** 将灰度/RGB 图像编码为 8-bit PNG（无隔行，filter 0/1） */
export function encodePNG(img: GrayImage): Uint8Array {
  const { width, height, channels, data } = img;
  const colorType = channels === 1 ? 0 : 2;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width, false);
  dv.setUint32(4, height, false);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * channels;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0; // filter type none
    raw.set(data.subarray(y * stride, (y + 1) * stride), rowStart + 1);
  }
  const idat = deflateSync(raw, { level: 9 });
  return concat([
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk("IHDR", ihdr),
    chunk("IDAT", new Uint8Array(idat)),
    chunk("IEND", new Uint8Array(0)),
  ]);
}

/** 最小 PNG 解码：支持 8-bit 灰度(0)/RGB(2)，无隔行；损坏时抛 CorruptFormatError */
export function decodePNG(bytes: Uint8Array): GrayImage {
  const issues: string[] = [];
  const u8 = bytes;
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (u8.length < 8 || sig.some((v, i) => u8[i] !== v)) {
    throw new CorruptFormatError("PNG 签名错误", ["缺少或错误的 PNG 文件签名"]);
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let interlace = 0;
  const idatParts: Uint8Array[] = [];
  let sawIHDR = false;

  while (off + 8 <= u8.length) {
    const len = new DataView(u8.buffer, u8.byteOffset + off, 4).getUint32(0, false);
    const type = new TextDecoder().decode(u8.subarray(off + 4, off + 8));
    const bodyStart = off + 8;
    if (bodyStart + len + 4 > u8.length) {
      throw new CorruptFormatError("PNG 块被截断", [`${type} 块长度越界`]);
    }
    const body = u8.subarray(bodyStart, bodyStart + len);
    const storedCrc = new DataView(u8.buffer, u8.byteOffset + bodyStart + len, 4).getUint32(0, false);
    if (crc32(concat([u8.subarray(off + 4, off + 8), body])) !== storedCrc) {
      issues.push(`${type} 块 CRC 校验失败`);
    }
    if (type === "IHDR") {
      width = new DataView(body.buffer, body.byteOffset, 4).getUint32(0, false);
      height = new DataView(body.buffer, body.byteOffset + 4, 4).getUint32(0, false);
      bitDepth = body[8]!;
      colorType = body[9]!;
      interlace = body[12]!;
      if (width === 0 || height === 0) issues.push("IHDR 尺寸为 0");
      if (bitDepth !== 8) issues.push(`仅支持 8-bit 位深，实际 ${bitDepth}`);
      if (colorType !== 0 && colorType !== 2) issues.push(`仅支持灰度/RGB，色彩类型 ${colorType}`);
      if (interlace !== 0) issues.push("不支持隔行 PNG");
      sawIHDR = true;
    } else if (type === "IDAT") {
      idatParts.push(body);
    } else if (type === "IEND") {
      break;
    }
    off = bodyStart + len + 4;
  }

  if (!sawIHDR) throw new CorruptFormatError("PNG 缺少 IHDR", issues.concat("缺少 IHDR 块"));
  if (idatParts.length === 0) throw new CorruptFormatError("PNG 缺少 IDAT", issues.concat("缺少 IDAT 块"));
  if (issues.length > 0) throw new CorruptFormatError("PNG 格式损坏", issues);

  const channels: 1 | 3 = colorType === 0 ? 1 : 3;
  let inflated: Uint8Array;
  try {
    inflated = new Uint8Array(inflateSync(concat(idatParts)));
  } catch {
    throw new CorruptFormatError("PNG 图像数据无法解压", ["IDAT zlib 解压失败"]);
  }
  const stride = width * channels;
  const expected = (stride + 1) * height;
  if (inflated.length !== expected) {
    throw new CorruptFormatError("PNG 图像数据长度不符", [
      `解压后 ${inflated.length} 字节，期望 ${expected}`,
    ]);
  }
  const data = new Uint8Array(stride * height);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)]!;
    const inRow = inflated.subarray(y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
    const cur = new Uint8Array(stride);
    const paeth = (a: number, b: number, c: number): number => {
      const p = a + b - c;
      const pa = Math.abs(p - a);
      const pb = Math.abs(p - b);
      const pc = Math.abs(p - c);
      if (pa <= pb && pa <= pc) return a;
      if (pb <= pc) return b;
      return c;
    };
    for (let x = 0; x < stride; x++) {
      const a = x >= channels ? cur[x - channels]! : 0;
      const b = prev[x]!;
      const c = x >= channels ? prev[x - channels]! : 0;
      const v = inRow[x]!;
      let out = v;
      if (filter === 0) out = v;
      else if (filter === 1) out = v + a;
      else if (filter === 2) out = v + b;
      else if (filter === 3) out = v + ((a + b) >> 1);
      else if (filter === 4) out = v + paeth(a, b, c);
      else throw new CorruptFormatError("PNG 使用了不支持的滤波器", [`行 ${y} filter=${filter}`]);
      cur[x] = out & 0xff;
    }
    data.set(cur, y * stride);
    prev.set(cur);
  }
  return { width, height, channels, data };
}
