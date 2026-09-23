import { deflateSync, inflateSync } from 'node:zlib';
import type { GelImage } from '../shared/types';

export class PngFormatError extends Error {}

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
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const out = new Uint8Array(12 + data.length);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, data.length);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(data, 8);
  dv.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

/** 8-bit 灰度 PNG 编码（filter 0）。 */
export function encodePng(img: GelImage): Uint8Array {
  const { width: w, height: h } = img;
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, w); dv.setUint32(4, h);
  ihdr[8] = 8; ihdr[9] = 0; // bit depth 8, color type 0 (grayscale)
  const raw = new Uint8Array(h * (w + 1));
  for (let y = 0; y < h; y++) {
    raw[y * (w + 1)] = 0;
    raw.set(img.pixels.subarray(y * w, (y + 1) * w), y * (w + 1) + 1);
  }
  const idat = deflateSync(raw, { level: 6 });
  const sig = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  const out = new Uint8Array(sig.length + 12 + 13 + 12 + idat.length + 12);
  let o = 0;
  out.set(sig, o); o += 8;
  const c1 = chunk('IHDR', ihdr); out.set(c1, o); o += c1.length;
  const c2 = chunk('IDAT', idat); out.set(c2, o); o += c2.length;
  const c3 = chunk('IEND', new Uint8Array(0)); out.set(c3, o);
  return out;
}

/** 解码（支持 filter 0-4，8-bit 灰度）。任何损坏都抛 PngFormatError → format_corrupt。 */
export function decodePng(buf: Uint8Array): GelImage {
  const sig = [137, 80, 78, 71, 13, 10, 26, 10];
  if (buf.length < 8 || sig.some((b, i) => buf[i] !== b)) throw new PngFormatError('bad signature');
  let o = 8;
  let w = 0, h = 0;
  const idat: Uint8Array[] = [];
  let seenIhdr = false, seenIend = false;
  while (o + 8 <= buf.length) {
    const dv = new DataView(buf.buffer, buf.byteOffset + o);
    const len = dv.getUint32(0);
    const type = String.fromCharCode(buf[o + 4], buf[o + 5], buf[o + 6], buf[o + 7]);
    if (o + 12 + len > buf.length) throw new PngFormatError(`truncated chunk ${type}`);
    const data = buf.subarray(o + 8, o + 8 + len);
    const crc = dv.getUint32(8 + len);
    if (crc32(buf.subarray(o + 4, o + 8 + len)) !== crc) throw new PngFormatError(`crc mismatch in ${type}`);
    if (type === 'IHDR') {
      const hd = new DataView(buf.buffer, buf.byteOffset + o + 8);
      w = hd.getUint32(0); h = hd.getUint32(4);
      if (data[8] !== 8 || data[9] !== 0) throw new PngFormatError('only 8-bit grayscale supported');
      seenIhdr = true;
    } else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') { seenIend = true; break; }
    o += 12 + len;
  }
  if (!seenIhdr || !seenIend || idat.length === 0) throw new PngFormatError('missing chunks');
  let raw: Uint8Array;
  try {
    raw = inflateSync(Buffer.concat(idat.map((d) => Buffer.from(d))));
  } catch {
    throw new PngFormatError('inflate failed');
  }
  const stride = w + 1;
  if (raw.length < h * stride) throw new PngFormatError('short pixel data');
  const px = new Uint8Array(w * h);
  let prev = new Uint8Array(w);
  for (let y = 0; y < h; y++) {
    const f = raw[y * stride];
    const row = raw.subarray(y * stride + 1, (y + 1) * stride);
    const cur = new Uint8Array(w);
    for (let x = 0; x < w; x++) {
      const a = x > 0 ? cur[x - 1] : 0;
      const b = prev[x];
      const c = x > 0 ? prev[x - 1] : 0;
      let v = row[x];
      if (f === 1) v += a;
      else if (f === 2) v += b;
      else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      } else if (f !== 0) throw new PngFormatError(`unknown filter ${f}`);
      cur[x] = v & 0xff;
    }
    px.set(cur, y * w);
    prev = cur;
  }
  return { width: w, height: h, pixels: px };
}
