import { deflateSync, crc32 } from 'node:zlib';

// 最小灰度 8-bit PNG 编码器（无第三方依赖，离线可用）
export function encodeGrayPng(width: number, height: number, pixels: Uint8Array): Buffer {
  if (pixels.length !== width * height) throw new Error('pixel buffer size mismatch');
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0; // filter none
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * (width + 1) + 1);
  }
  const idat = deflateSync(raw);
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', idat), chunk('IEND', Buffer.alloc(0))]);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

export function decodeGrayPngSize(buf: Buffer): { width: number; height: number } {
  if (buf.length < 24) throw new Error('png too short');
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}
