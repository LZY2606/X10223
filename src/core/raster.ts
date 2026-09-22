/**
 * 8 位灰度光栅与最小 PNG 编解码。
 * 解码同时支持 Node(zlib) 与浏览器(DecompressionStream)，业务规则不依赖浏览器 API。
 */
import { deflateSync, inflateSync } from 'node:zlib';

export interface Raster {
  width: number;
  height: number;
  /** 逐行 0..255 灰度，长度 width*height */
  data: Uint8Array;
  /** 稳定身份：图像字节 sha256 的前 12 位（由外层计算后注入） */
  frameId: string;
}

export function makeRaster(width: number, height: number, fill = 0): Raster {
  return { width, height, data: new Uint8Array(width * height).fill(fill), frameId: '' };
}

export function px(r: Raster, x: number, y: number): number {
  return r.data[y * r.width + x] ?? 0;
}

export function setPx(r: Raster, x: number, y: number, v: number): void {
  if (x < 0 || y < 0 || x >= r.width || y >= r.height) return;
  r.data[y * r.width + x] = Math.max(0, Math.min(255, Math.round(v)));
}

const CRC_TABLE: number[] = (() => {
  const t = new Array<number>(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    const idx = (c ^ (buf[i] ?? 0)) & 0xff;
    c = (CRC_TABLE[idx] ?? 0) ^ (c >>> 8);
  }
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, body: Uint8Array): Uint8Array {
  const len = body.length;
  const out = new Uint8Array(12 + len);
  const dv = new DataView(out.buffer);
  dv.setUint32(0, len);
  for (let i = 0; i < 4; i++) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  dv.setUint32(8 + len, crc32(out.subarray(4, 8 + len)));
  return out;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const total = parts.reduce((a, p) => a + p.length, 0);
  const out = new Uint8Array(total);
  let off = 0;
  for (const p of parts) {
    out.set(p, off);
    off += p.length;
  }
  return out;
}

/** 编码为 8 位灰度 PNG（色彩类型 0，filter 0） */
export function encodePng(r: Raster): Uint8Array {
  const sig = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = new Uint8Array(13);
  const dv = new DataView(ihdr.buffer);
  dv.setUint32(0, r.width);
  dv.setUint32(4, r.height);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = r.width + 1;
  const raw = new Uint8Array(stride * r.height);
  for (let y = 0; y < r.height; y++) {
    raw[y * stride] = 0;
    raw.set(r.data.subarray(y * r.width, (y + 1) * r.width), y * stride + 1);
  }
  return concat([
    sig,
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw, { level: 9 })),
    chunk('IEND', new Uint8Array(0))
  ]);
}

function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

/** 解析 8 位灰度 PNG（同时兼容我们生成的灰度图；其它格式返回 format-corrupt 诊断由上层处理） */
export function decodePng(bytes: Uint8Array): Raster {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const sig = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (bytes.length < 8 || sig.some((v, i) => bytes[i] !== v)) {
    throw makeCorrupt('PNG 签名不匹配');
  }
  let off = 8;
  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = -1;
  const idat: Uint8Array[] = [];
  while (off + 8 <= bytes.length) {
    const len = view.getUint32(off);
    const type = String.fromCharCode(...bytes.subarray(off + 4, off + 8));
    const start = off + 8;
    if (start + len + 4 > bytes.length) throw makeCorrupt(`${type} 长度越界`);
    const body = bytes.subarray(start, start + len);
    if (type === 'IHDR') {
      if (len < 13) throw makeCorrupt('IHDR 过短');
      width = new DataView(body.buffer, body.byteOffset).getUint32(0);
      height = new DataView(body.buffer, body.byteOffset).getUint32(4);
      bitDepth = body[8]!;
      colorType = body[9]!;
    } else if (type === 'IDAT') {
      idat.push(body.slice());
    } else if (type === 'IEND') {
      break;
    }
    off = start + len + 4;
  }
  if (bitDepth !== 8 || colorType !== 0) {
    throw makeCorrupt(`仅支持 8 位灰度 PNG（实际 depth=${bitDepth} color=${colorType}）`);
  }
  if (width <= 0 || height <= 0) throw makeCorrupt('图像尺寸非法');
  const inflated = inflateSync(concat(idat));
  const stride = width + 1;
  if (inflated.length < stride * height) throw makeCorrupt('IDAT 解压后数据不足');
  const data = new Uint8Array(width * height);
  const prev = new Uint8Array(width);
  for (let y = 0; y < height; y++) {
    const filter = inflated[y * stride]!;
    const line = inflated.subarray(y * stride + 1, y * stride + 1 + width);
    const cur = new Uint8Array(width);
    for (let x = 0; x < width; x++) {
      const a = x > 0 ? cur[x - 1]! : 0;
      const b = prev[x]!;
      const c = x > 0 ? prev[x - 1]! : 0;
      let v = line[x]!;
      if (filter === 1) v += a;
      else if (filter === 2) v += b;
      else if (filter === 3) v += (a + b) >> 1;
      else if (filter === 4) v += paeth(a, b, c);
      else if (filter !== 0) throw makeCorrupt(`不支持的 PNG 行过滤器 ${filter}`);
      cur[x] = v & 0xff;
    }
    data.set(cur, y * width);
    prev.set(cur);
  }
  return { width, height, data, frameId: '' };
}

export interface CorruptError extends Error {
  failureClass: 'format-corrupt';
}

function makeCorrupt(msg: string): CorruptError {
  const e = new Error(msg) as CorruptError;
  e.failureClass = 'format-corrupt';
  return e;
}

/** 顺时针旋转 90/180/270 度（最近邻，像素级可重放） */
export function rotate90(r: Raster, cwQuarters: number): Raster {
  const q = ((cwQuarters % 4) + 4) % 4;
  if (q === 0) return { ...r, data: r.data.slice() };
  const w = r.width;
  const h = r.height;
  const same = q === 2;
  const nw = same ? w : h;
  const nh = same ? h : w;
  const out = makeRaster(nw, nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = px(r, x, y);
      let nx = x;
      let ny = y;
      if (q === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (q === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      setPx(out, nx, ny, v);
    }
  }
  return out;
}

/** 旋转后把像素点从旧帧映射到新帧（与 rotate90 一致） */
export function rotatePoint(
  x: number,
  y: number,
  w: number,
  h: number,
  cwQuarters: number
): [number, number] {
  const q = ((cwQuarters % 4) + 4) % 4;
  if (q === 0) return [x, y];
  if (q === 1) return [h - 1 - y, x];
  if (q === 2) return [w - 1 - x, h - 1 - y];
  return [y, w - 1 - x];
}

/**
 * 沿泳道截面取强度轮廓。
 * 中心线 centerline 为像素折线；对每个弧长采样点，在法向 halfWidth 范围内取平均。
 */
export function laneProfile(
  r: Raster,
  centerline: { x: number; y: number }[],
  halfWidth: number
): { u: number; intensity: number; x: number; y: number }[] {
  const out: { u: number; intensity: number; x: number; y: number }[] = [];
  let u = 0;
  for (let i = 0; i < centerline.length - 1; i++) {
    const p0 = centerline[i]!;
    const p1 = centerline[i + 1]!;
    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    const segLen = Math.hypot(dx, dy) || 1;
    const nx = -dy / segLen;
    const ny = dx / segLen;
    const steps = Math.max(1, Math.round(segLen));
    for (let s = 0; s < steps; s++) {
      const t = s / steps;
      const cx = p0.x + dx * t;
      const cy = p0.y + dy * t;
      let sum = 0;
      let n = 0;
      for (let w2 = -halfWidth; w2 <= halfWidth; w2++) {
        sum += px(r, Math.round(cx + nx * w2), Math.round(cy + ny * w2));
        n++;
      }
      out.push({ u, intensity: sum / n, x: cx, y: cy });
      u += segLen / steps;
    }
  }
  return out;
}

/** 由左右边界折线重采样出中心线（微笑弯曲时中心线也是曲线） */
export function centerlineFromBounds(
  left: { x: number; y: number }[],
  right: { x: number; y: number }[],
  samples = 80
): { x: number; y: number }[] {
  const interp = (
    poly: { x: number; y: number }[],
    y: number
  ): { x: number; y: number } => {
    if (y <= poly[0]!.y) return { ...poly[0]! };
    if (y >= poly[poly.length - 1]!.y) return { ...poly[poly.length - 1]! };
    for (let i = 0; i < poly.length - 1; i++) {
      const a = poly[i]!;
      const b = poly[i + 1]!;
      if (y >= a.y && y <= b.y) {
        const t = (y - a.y) / (b.y - a.y || 1);
        return { x: a.x + (b.x - a.x) * t, y };
      }
    }
    return { ...poly[poly.length - 1]! };
  };
  const y0 = Math.max(left[0]!.y, right[0]!.y);
  const y1 = Math.min(left[left.length - 1]!.y, right[right.length - 1]!.y);
  const out: { x: number; y: number }[] = [];
  for (let i = 0; i < samples; i++) {
    const y = y0 + ((y1 - y0) * i) / (samples - 1);
    const l = interp(left, y);
    const rr = interp(right, y);
    out.push({ x: (l.x + rr.x) / 2, y });
  }
  return out;
}
