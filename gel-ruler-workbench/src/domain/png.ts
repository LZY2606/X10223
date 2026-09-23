// 最小 8-bit 灰度 PNG 编码器（zlib + CRC32，Node/测试可直接调用）。
import { deflateSync, crc32 } from 'node:zlib';

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const body = Buffer.concat([typeBuf, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body) >>> 0, 0);
  return Buffer.concat([len, body, crc]);
}

/** gray: 长度 width*height 的 0..255 数组（0=黑，255=白） */
export function encodeGrayPNG(width: number, height: number, gray: Uint8Array): Buffer {
  if (gray.length !== width * height) {
    throw new Error(`灰度数据长度 ${gray.length} 与 ${width}x${height} 不符`);
  }
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 = grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  // 每行加 filter byte 0
  const raw = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    gray.subarray(y * width, (y + 1) * width).forEach((v, x) => {
      raw[y * (width + 1) + 1 + x] = v;
    });
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0))
  ]);
}

/** 解码 8-bit 灰度/RGB PNG 的极简校验：仅校验签名与 IHDR（用于格式损坏检测的输入侧） */
export function readPNGHeader(bytes: Buffer): { width: number; height: number; colorType: number } {
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  for (let i = 0; i < sig.length; i++) {
    if (bytes[i] !== sig[i]) throw new Error('PNG 签名无效');
  }
  const width = bytes.readUInt32BE(16);
  const height = bytes.readUInt32BE(20);
  const colorType = bytes[25];
  return { width, height, colorType };
}
