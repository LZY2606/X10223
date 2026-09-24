/**
 * 零依赖 PNG 编码器（8-bit grayscale + RGB），用于确定性生成离线凝胶领域案例图像，
 * 以及导入侧的最小签名/CRC 校验（区分 FORMAT_CORRUPT 与语义问题）。
 */
import zlib from 'node:zlib';

export function encodePng(width: number, height: number, channels: 1 | 3, raster: Uint8Array | Uint8ClampedArray): Buffer {
  const colorType = channels === 1 ? 0 : 2;
  const bitDepth = 8;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0; // filter type 0
    Buffer.from(raster.buffer, raster.byteOffset + y * stride, stride).copy(raw, y * (stride + 1) + 1);
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = bitDepth;
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const chunks = [Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])]), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(raw)), chunk('IEND', Buffer.alloc(0))];
  return Buffer.concat(chunks);
}

function chunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
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

export function crc32(buf: Buffer): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return c ^ 0xffffffff;
}

/** 严格解析：签名/IHDR/IDAT CRC 损坏即抛 FORMAT_CORRUPT。返回像素与尺寸。 */
export function decodePng(buf: Buffer): { width: number; height: number; channels: 1 | 3; raster: Buffer } {
  if (buf.length < 8 + 25 || !buf.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    throw new PngFormatError('PNG 签名损坏或被截断');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (off < buf.length) {
    if (off + 8 > buf.length) throw new PngFormatError('PNG 块长度区被截断（半写文件）');
    const len = buf.readUInt32BE(off);
    const type = buf.toString('ascii', off + 4, off + 8);
    const dataStart = off + 8;
    if (dataStart + len + 4 > buf.length) throw new PngFormatError(`PNG 块 ${type} 数据被截断（半写文件）`);
    const data = buf.subarray(dataStart, dataStart + len);
    const storedCrc = buf.readUInt32BE(dataStart + len);
    if ((crc32(Buffer.concat([Buffer.from(type, 'ascii'), data])) >>> 0) !== (storedCrc >>> 0)) {
      throw new PngFormatError(`PNG 块 ${type} CRC 校验失败（格式损坏）`);
    }
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (data[12] !== 0 || bitDepth !== 8 || (colorType !== 0 && colorType !== 2)) {
        throw new PngFormatError(`不支持的 PNG 形态 colorType=${colorType} bitDepth=${bitDepth}`);
      }
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
    off = dataStart + len + 4;
  }
  if (!width || !height) throw new PngFormatError('缺少 IHDR');
  const channels = (colorType === 0 ? 1 : 3) as 1 | 3;
  let inflated: Buffer;
  try {
    inflated = zlib.inflateSync(Buffer.concat(idat));
  } catch {
    throw new PngFormatError('IDAT 解压失败（格式损坏/半写）');
  }
  const stride = width * channels;
  if (inflated.length !== (stride + 1) * height) throw new PngFormatError('像素数据长度与 IHDR 不符（半写）');
  const raster = Buffer.alloc(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * (stride + 1)];
    if (filter !== 0) throw new PngFormatError(`不支持的 PNG 行滤波类型 ${filter}`);
    inflated.copy(raster, y * stride, y * (stride + 1) + 1, y * (stride + 1) + 1 + stride);
  }
  return { width, height, channels, raster };
}

export class PngFormatError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PngFormatError';
  }
}
