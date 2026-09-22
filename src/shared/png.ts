import { deflateSync, inflateSync, crc32 } from 'node:zlib';

export interface Raster {
  width: number;
  height: number;
  channels: 1 | 3;
  data: Uint8Array; // length = w*h*channels
}

function chunk(type: string, body: Buffer): Buffer {
  const typeBuf = Buffer.from(type, 'ascii');
  const len = Buffer.alloc(4);
  len.writeUInt32BE(body.length, 0);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, body])) >>> 0, 0);
  return Buffer.concat([len, typeBuf, body, crc]);
}

export function encodePng(raster: Raster): Buffer {
  const { width, height, channels } = raster;
  const colorType = channels === 1 ? 0 : 2;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = colorType;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = width * channels;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let row = 0; row < height; row++) {
    raw[row * (stride + 1)] = 0; // filter type 0
    raster.data.subarray(row * stride, (row + 1) * stride).forEach((v, i) => {
      raw[row * (stride + 1) + 1 + i] = v;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 6 })),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

export function decodePng(buffer: Buffer): Raster {
  if (buffer.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') {
    const error = new Error('PNG_SIGNATURE') as Error & { failureClass?: string };
    error.failureClass = 'FORMAT_CORRUPT';
    throw error;
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  const idat: Buffer[] = [];
  while (offset < buffer.length) {
    const length = buffer.readUInt32BE(offset);
    const type = buffer.subarray(offset + 4, offset + 8).toString('ascii');
    const body = buffer.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = body.readUInt32BE(0);
      height = body.readUInt32BE(4);
      bitDepth = body[8];
      colorType = body[9];
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(body));
    } else if (type === 'IEND') {
      break;
    }
    offset += 12 + length;
  }
  if (bitDepth !== 8 || (colorType !== 0 && colorType !== 2)) {
    const error = new Error(`PNG_UNSUPPORTED depth=${bitDepth} color=${colorType}`) as Error & {
      failureClass?: string;
    };
    error.failureClass = 'FORMAT_CORRUPT';
    throw error;
  }
  const channels = (colorType === 0 ? 1 : 3) as 1 | 3;
  const inflated = inflateSync(Buffer.concat(idat));
  const stride = width * channels;
  const data = new Uint8Array(width * height * channels);
  let pos = 0;
  let prev = new Uint8Array(stride);
  for (let row = 0; row < height; row++) {
    const filter = inflated[pos++];
    const cur = new Uint8Array(stride);
    for (let i = 0; i < stride; i++) {
      const raw = inflated[pos++];
      const left = i >= channels ? cur[i - channels] : 0;
      const up = prev[i];
      const upLeft = i >= channels ? prev[i - channels] : 0;
      let value: number;
      switch (filter) {
        case 0:
          value = raw;
          break;
        case 1:
          value = raw + left;
          break;
        case 2:
          value = raw + up;
          break;
        case 3:
          value = raw + ((left + up) >> 1);
          break;
        case 4: {
          const p = left + up - upLeft;
          const pa = Math.abs(p - left);
          const pb = Math.abs(p - up);
          const pc = Math.abs(p - upLeft);
          value = raw + (pa <= pb && pa <= pc ? left : pb <= pc ? up : upLeft);
          break;
        }
        default: {
          const error = new Error(`PNG_BAD_FILTER ${filter}`) as Error & { failureClass?: string };
          error.failureClass = 'FORMAT_CORRUPT';
          throw error;
        }
      }
      cur[i] = value & 0xff;
    }
    data.set(cur, row * stride);
    prev = cur;
  }
  return { width, height, channels, data };
}

export function grayAt(raster: Raster, x: number, y: number): number {
  if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) return 0;
  const idx = (y * raster.width + x) * raster.channels;
  if (raster.channels === 1) return raster.data[idx];
  return Math.round(
    (raster.data[idx] * 30 + raster.data[idx + 1] * 59 + raster.data[idx + 2] * 11) / 100,
  );
}
