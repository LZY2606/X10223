import { deflateSync, inflateSync, crc32 } from "node:zlib";

/**
 * 最小 PNG 编解码：灰度 8bit（color type 0）。
 * 案例包中的“原图”是真实可解码 PNG，像素级来源可复核。
 */

function chunk(type: string, data: Uint8Array): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, "ascii"), Buffer.from(data)]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

export function encodeGrayPng(width: number, height: number, gray: Uint8Array): Uint8Array {
  if (gray.length !== width * height) throw new Error("png.size_mismatch");
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type gray
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width + 1;
  const raw = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0; // filter none
    gray.copy(raw, y * stride + 1, y * width, (y + 1) * width);
  }
  const idat = deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", idat),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}

export interface GrayImage {
  width: number;
  height: number;
  gray: Uint8Array;
}

export function decodePng(bytes: Uint8Array): GrayImage {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) throw new Error("png.bad_signature");
  }
  let pos = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat: Buffer[] = [];
  while (pos < bytes.length) {
    if (pos + 8 > bytes.length) throw new Error("png.truncated_chunk");
    const len = Buffer.from(bytes.slice(pos, pos + 4)).readUInt32BE(0);
    const type = Buffer.from(bytes.slice(pos + 4, pos + 8)).toString("ascii");
    const dataStart = pos + 8;
    if (dataStart + len + 4 > bytes.length) throw new Error("png.truncated_chunk_body");
    const data = bytes.slice(dataStart, dataStart + len);
    if (type === "IHDR") {
      width = Buffer.from(data.slice(0, 4)).readUInt32BE(0);
      height = Buffer.from(data.slice(4, 8)).readUInt32BE(0);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0) throw new Error("png.interlace_unsupported");
    } else if (type === "IDAT") {
      idat.push(Buffer.from(data));
    } else if (type === "IEND") {
      break;
    }
    pos = dataStart + len + 4;
  }
  if (bitDepth !== 8) throw new Error("png.bitdepth_unsupported");
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 6 ? 4 : -1;
  if (channels === -1) throw new Error("png.colortype_unsupported");
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels + 1;
  if (inflated.length !== stride * height) throw new Error("png.size_mismatch");
  const out = new Uint8Array(width * height);
  const bpp = channels;
  let prev = new Uint8Array(width * channels);
  const paeth = (a: number, b: number, c: number) => {
    const p = a + b - c;
    const pa = Math.abs(p - a);
    const pb = Math.abs(p - b);
    const pc = Math.abs(p - c);
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  };
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * stride];
    const row = inflated.subarray(y * stride + 1, (y + 1) * stride);
    const cur = new Uint8Array(width * channels);
    for (let x = 0; x < row.length; x++) {
      const a = x >= bpp ? cur[x - bpp] : 0;
      const b = prev[x];
      const c = x >= bpp ? prev[x - bpp] : 0;
      let v = row[x];
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw new Error("png.bad_filter");
      cur[x] = v & 0xff;
    }
    for (let x = 0; x < width; x++) out[y * width + x] = cur[x * channels];
    prev = cur;
  }
  return { width, height, gray: out };
}
