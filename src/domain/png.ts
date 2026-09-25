import { deflateSync, inflateSync } from 'node:zlib';
import { diagnostic } from '../shared/diagnostics.js';
import { DomainFailure } from '../shared/result.js';
import { sha256Hex } from '../shared/ids.js';

export interface DecodedImage {
  width: number;
  height: number;
  channels: 1 | 3;
  grayscale: Uint8Array;
  sha256: string;
}

export interface Budget {
  maxBytes: number;
  maxDimension: number;
  maxPixels: number;
}

export const DEFAULT_BUDGET: Budget = {
  maxBytes: 32 * 1024 * 1024,
  maxDimension: 16384,
  maxPixels: 64_000_000,
};

const PNG_SIGNATURE = [137, 80, 78, 71, 13, 10, 26, 10];

function crcTable(): Uint32Array {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[n] = c >>> 0;
  }
  return table;
}

const CRC_TABLE = crcTable();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c = CRC_TABLE[(c ^ buf[i]!) & 0xff]! ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

export function encodePngGray(width: number, height: number, pixels: Uint8Array): Uint8Array {
  if (pixels.length !== width * height) {
    throw new Error(`pixel buffer length ${pixels.length} != ${width}*${height}`);
  }
  const chunks: number[] = [];
  for (const b of PNG_SIGNATURE) chunks.push(b);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, width);
  dv.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  pushChunk(chunks, 0x49484452, ihdr);
  const stride = width + 1;
  const raw = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    raw[y * stride] = 0;
    raw.set(pixels.subarray(y * width, (y + 1) * width), y * stride + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  pushChunk(chunks, 0x49444154, idat);
  pushChunk(chunks, 0x49454e44, new Uint8Array(0));
  return Uint8Array.from(chunks);
}

function pushChunk(out: number[], type: number, data: Uint8Array): void {
  const len = data.length;
  const header = new Uint8Array(4);
  new DataView(header.buffer).setUint32(0, len);
  for (const b of header) out.push(b);
  const typeBytes = [(type >>> 24) & 0xff, (type >>> 16) & 0xff, (type >>> 8) & 0xff, type & 0xff];
  const body = new Uint8Array(4 + data.length);
  typeBytes.forEach((b, i) => body.set([b], i));
  body.set(data, 4);
  for (const b of typeBytes) out.push(b);
  for (const b of data) out.push(b);
  const crc = new Uint8Array(4);
  new DataView(crc.buffer).setUint32(0, crc32(body));
  for (const b of crc) out.push(b);
}

export function decodePng(bytes: Uint8Array, budget: Budget = DEFAULT_BUDGET): DecodedImage {
  if (bytes.length < 8 || !PNG_SIGNATURE.every((b, i) => bytes[i] === b)) {
    throw new DomainFailure('FORMAT_CORRUPT', 'PNG 签名不匹配', [
      diagnostic('png.signature', '文件头不是合法 PNG 签名', 'error', { kind: 'bundle' }, '需要 89 50 4E 47 0D 0A 1A 0A'),
    ]);
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idatParts: Uint8Array[] = [];
  let seenIend = false;
  try {
    while (offset < bytes.length) {
      if (offset + 8 > bytes.length) {
        throw new DomainFailure('FORMAT_CORRUPT', 'PNG 数据块被截断', [
          diagnostic('png.truncated', `偏移 ${offset} 处数据块长度/类型不完整`, 'error', { kind: 'bundle' }),
        ]);
      }
      const length = new DataView(bytes.buffer, bytes.byteOffset + offset, 4).getUint32(0);
      const type = new DataView(bytes.buffer, bytes.byteOffset + offset + 4, 4).getUint32(0);
      const dataStart = offset + 8;
      const dataEnd = dataStart + length;
      if (dataEnd + 4 > bytes.length) {
        throw new DomainFailure('FORMAT_CORRUPT', `PNG 数据块 ${type.toString(16)} 超出文件长度`, [
          diagnostic('png.truncated', `声明长度 ${length} 超出文件`, 'error', { kind: 'bundle' }),
        ]);
      }
      const body = bytes.subarray(offset + 4, dataEnd);
      const expectedCrc = new DataView(bytes.buffer, bytes.byteOffset + dataEnd, 4).getUint32(0);
      if (crc32(body) !== expectedCrc) {
        throw new DomainFailure('FORMAT_CORRUPT', `PNG 数据块 CRC 校验失败: ${fourcc(type)}`, [
          diagnostic('png.crc', `数据块 ${fourcc(type)} 的 CRC 不匹配，内容可能被截断或损坏`, 'error', { kind: 'bundle' }),
        ]);
      }
      const data = bytes.subarray(dataStart, dataEnd);
      if (type === 0x49484452) {
        if (length !== 13) throw new DomainFailure('FORMAT_CORRUPT', 'IHDR 长度非法', [diagnostic('png.ihdr', 'IHDR 必须为 13 字节', 'error', { kind: 'bundle' })]);
        width = new DataView(data.buffer, data.byteOffset, 4).getUint32(0);
        height = new DataView(data.buffer, data.byteOffset + 4, 4).getUint32(0);
        bitDepth = data[8]!;
        colorType = data[9]!;
        if (width === 0 || height === 0) throw new DomainFailure('FORMAT_CORRUPT', '图像尺寸为 0', [diagnostic('png.ihdr.size', '宽高必须为正', 'error', { kind: 'bundle' })]);
        if (width > budget.maxDimension || height > budget.maxDimension) {
          throw new DomainFailure(
            'RESOURCE_BUDGET_EXHAUSTED',
            `图像尺寸 ${width}x${height} 超过预算 ${budget.maxDimension}`,
            [diagnostic('png.budget.dimension', `单边像素超过 ${budget.maxDimension}`, 'error', { kind: 'bundle' })],
            { width, height, budget },
          );
        }
        if (width * height > budget.maxPixels) {
          throw new DomainFailure(
            'RESOURCE_BUDGET_EXHAUSTED',
            `像素总数 ${width * height} 超过预算 ${budget.maxPixels}`,
            [diagnostic('png.budget.pixels', '像素总数超过预算', 'error', { kind: 'bundle' })],
            { pixels: width * height, budget },
          );
        }
        if (colorType !== 0 && colorType !== 2) {
          throw new DomainFailure('FORMAT_CORRUPT', `不支持的颜色类型 ${colorType}`, [
            diagnostic('png.colortype', '仅支持灰度(0)与真彩色(2)', 'error', { kind: 'bundle' }),
          ]);
        }
        if (bitDepth !== 8) {
          throw new DomainFailure('FORMAT_CORRUPT', `不支持的位深 ${bitDepth}`, [
            diagnostic('png.bitdepth', '仅支持 8 位', 'error', { kind: 'bundle' }),
          ]);
        }
      } else if (type === 0x49444154) {
        idatParts.push(data);
      } else if (type === 0x49454e44) {
        seenIend = true;
        break;
      }
      offset = dataEnd + 4;
    }
    if (!seenIend) throw new DomainFailure('FORMAT_CORRUPT', '缺少 IEND 数据块', [diagnostic('png.iend', 'PNG 流未以 IEND 结束', 'error', { kind: 'bundle' })]);
    const channels: 1 | 3 = colorType === 2 ? 3 : 1;
    const inflated = inflateSync(Buffer.concat(idatParts.map((p) => Buffer.from(p))));
    const stride = Math.ceil((width * channels * bitDepth) / 8) + 1;
    if (inflated.length !== stride * height) {
      throw new DomainFailure('FORMAT_CORRUPT', `解压后长度 ${inflated.length} 与声明尺寸 ${width}x${height} 不符`, [
        diagnostic('png.scanline', '扫描线数据长度不一致', 'error', { kind: 'bundle' }),
      ]);
    }
    const grayscale = new Uint8Array(width * height);
    let prevRow = new Uint8Array(width * channels);
    for (let y = 0; y < height; y++) {
      const filter = inflated[y * stride]!;
      const row = inflated.subarray(y * stride + 1, y * stride + 1 + width * channels);
      const recon = unfilter(row, prevRow, filter, channels, width);
      for (let x = 0; x < width; x++) {
        grayscale[y * width + x] = channels === 1 ? recon[x]! : Math.round(0.299 * recon[x * 3]! + 0.587 * recon[x * 3 + 1]! + 0.114 * recon[x * 3 + 2]!);
      }
      prevRow = recon;
    }
    if (bytes.length > budget.maxBytes) {
      throw new DomainFailure('RESOURCE_BUDGET_EXHAUSTED', `文件 ${bytes.length} 字节超过预算 ${budget.maxBytes}`, [
        diagnostic('png.budget.bytes', '文件体积超过预算', 'error', { kind: 'bundle' }),
      ]);
    }
    return { width, height, channels, grayscale, sha256: sha256Hex(bytes) };
  } catch (e) {
    if (e instanceof DomainFailure) throw e;
    throw new DomainFailure('FORMAT_CORRUPT', `PNG 解压失败: ${(e as Error).message}`, [
      diagnostic('png.zlib', (e as Error).message, 'error', { kind: 'bundle' }),
    ]);
  }
}

function unfilter(row: Uint8Array, prev: Uint8Array, filter: number, channels: number, width: number): Uint8Array {
  const out = new Uint8Array(row.length);
  const bpp = channels;
  for (let i = 0; i < row.length; i++) {
    const a = i >= bpp ? out[i - bpp]! : 0;
    const b = prev[i] ?? 0;
    const c = i >= bpp ? prev[i - bpp]! : 0;
    switch (filter) {
      case 0:
        out[i] = row[i]!;
        break;
      case 1:
        out[i] = (row[i]! + a) & 0xff;
        break;
      case 2:
        out[i] = (row[i]! + b) & 0xff;
        break;
      case 3:
        out[i] = (row[i]! + Math.floor((a + b) / 2)) & 0xff;
        break;
      case 4: {
        const p = a + b - c;
        const pa = Math.abs(p - a);
        const pb = Math.abs(p - b);
        const pc = Math.abs(p - c);
        const pred = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        out[i] = (row[i]! + pred) & 0xff;
        break;
      }
      default:
        throw new DomainFailure('FORMAT_CORRUPT', `不支持的 PNG 过滤器 ${filter}`, [
          diagnostic('png.filter', `非法扫描行过滤器类型 ${filter}`, 'error', { kind: 'bundle' }),
        ]);
    }
  }
  return out;
}

function fourcc(type: number): string {
  return String.fromCharCode((type >>> 24) & 255, (type >>> 16) & 255, (type >>> 8) & 255, type & 255);
}
