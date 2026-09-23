import { deflateSync } from "node:zlib";
import type { GrayImage, ImageGeneratorSpec, Point } from "./types.js";

// Mulberry32 — small deterministic PRNG so case-pack pixels are reproducible.
export function makeRng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

interface ArcPos {
  x: number;
  y: number;
  tx: number;
  ty: number;
  s: number;
}

// Quadratic bezier centerline P0->P1 (control Pc); samples are arc-length spaced.
function centerlineSamples(spec: ImageGeneratorSpec, laneIndex: number): ArcPos[] {
  const lane = spec.lanes[laneIndex]!;
  const p0 = { x: lane.centerX, y: lane.wellY };
  const pc = { x: lane.centerX + lane.curve.cx, y: lane.wellY + lane.curve.cy };
  const p2 = { x: lane.centerX + lane.curve.x2, y: lane.wellY + lane.curve.y2 };
  const out: ArcPos[] = [];
  let prev: { x: number; y: number } | null = null;
  let length = 0;
  const N = 400;
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    const u = 1 - t;
    const x = u * u * p0.x + 2 * u * t * pc.x + t * t * p2.x;
    const y = u * u * p0.y + 2 * u * t * pc.y + t * t * p2.y;
    const dx = 2 * u * (pc.x - p0.x) + 2 * t * (p2.x - pc.x);
    const dy = 2 * u * (pc.y - p0.y) + 2 * t * (p2.y - pc.y);
    if (prev) length += Math.hypot(x - prev.x, y - prev.y);
    const nl = Math.hypot(dx, dy) || 1;
    out.push({ x, y, tx: dy / nl, ty: -dx / nl, s: length });
    prev = { x, y };
  }
  return out;
}

export function generateGelImage(spec: ImageGeneratorSpec): GrayImage {
  const { width, height } = spec;
  const dark = new Float32Array(width * height); // added darkness
  const rng = makeRng(spec.seed);

  spec.lanes.forEach((lane, laneIndex) => {
    const samples = centerlineSamples(spec, laneIndex);
    const totalLen = samples[samples.length - 1]!.s;
    for (const band of lane.bands) {
      const target = Math.max(0, Math.min(totalLen, band.s));
      const centerIdx = samples.findIndex((sp) => sp.s >= target);
      const center = samples[Math.max(1, centerIdx)]!;
      const amp = band.intensity * spec.exposure.gain;
      const halfW = Math.ceil(band.width * 3) + 4;
      const x0 = Math.max(0, Math.floor(center.x - halfW));
      const x1 = Math.min(width - 1, Math.ceil(center.x + halfW));
      const y0 = Math.max(0, Math.floor(center.y - halfW));
      const y1 = Math.min(height - 1, Math.ceil(center.y + halfW));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const rx = x - center.x;
          const ry = y - center.y;
          // along-arc coordinate: project onto tangent + normal
          const along = rx * center.tx + ry * center.ty * -1 * 0 + -(rx * -center.ty) + ry * center.tx;
          const lateral = rx * -center.ty + ry * center.tx;
          const axial = -rx * center.ty + ry * center.tx; // along tangent (positive down)
          void along;
          let darkness =
            amp *
            Math.exp(-(lateral * lateral) / (2 * (lane.width * 0.5) ** 2)) *
            Math.exp(-(axial * axial) / (2 * band.width ** 2));
          if (band.smear && band.smear > 0 && axial > 0) {
            darkness +=
              amp *
              0.6 *
              Math.exp(-(lateral * lateral) / (2 * (lane.width * 0.7) ** 2)) *
              Math.exp(-axial / band.smear);
          }
          dark[y * width + x]! += darkness;
        }
      }
    }
  });

  const pixels = new Uint8Array(width * height);
  for (let i = 0; i < pixels.length; i++) {
    let v = 215 + (rng() - 0.5) * 14;
    v -= dark[i]!;
    v = 255 * Math.pow(Math.max(0, Math.min(255, v)) / 255, spec.exposure.gamma);
    if (v < spec.exposure.saturationFloor) v = spec.exposure.saturationFloor; // clip (0 after floor mapping)
    pixels[i] = Math.max(0, Math.min(255, Math.round(v)));
  }
  return { width, height, pixels, frame: `raw:${spec.seed}` };
}

// Mark already-clipped band cores as exactly 0 so saturation is unambiguous.
export function punchSaturatedCores(spec: ImageGeneratorSpec, image: GrayImage): void {
  spec.lanes.forEach((lane, laneIndex) => {
    if (!lane.bands.some((b) => b.saturated)) return;
    const samples = centerlineSamples(spec, laneIndex);
    for (const band of lane.bands) {
      if (!band.saturated) continue;
      const target = band.s;
      const idx = Math.max(1, samples.findIndex((sp) => sp.s >= target));
      const c = samples[idx]!;
      const r = Math.max(2, Math.round(band.width));
      for (let y = Math.max(0, Math.floor(c.y - r)); y <= Math.min(image.height - 1, c.y + r); y++) {
        for (let x = Math.max(0, Math.floor(c.x - r)); x <= Math.min(image.width - 1, c.x + r); x++) {
          const axial = -(x - c.x) * -c.ty + (y - c.y) * c.tx;
          const lateral = (x - c.x) * -c.ty + (y - c.y) * c.tx;
          if (Math.abs(axial) <= r * 0.8 && Math.abs(lateral) <= lane.width * 0.45) {
            image.pixels[y * image.width + x] = 0;
          }
        }
      }
    }
  });
}

export function rotateCw(image: GrayImage, degrees: 0 | 90 | 180 | 270, frameSuffix: string): GrayImage {
  if (degrees === 0) return { ...image, frame: image.frame + frameSuffix };
  const turns = ((degrees % 360) / 90) as 0 | 1 | 2 | 3;
  let src = image;
  for (let t = 0; t < turns; t++) {
    const w = src.height;
    const h = src.width;
    const out = new Uint8Array(w * h);
    for (let y = 0; y < src.height; y++) {
      for (let x = 0; x < src.width; x++) {
        // 90 CW: dst(x',y') = src(x,y) with x' = H-1-y, y' = x
        const nx = src.height - 1 - y;
        const ny = x;
        out[ny * w + nx] = src.pixels[y * src.width + x]!;
      }
    }
    src = { width: w, height: h, pixels: out, frame: src.frame };
  }
  return { ...src, frame: image.frame + frameSuffix };
}

export function transformPointCw(p: Point, srcW: number, srcH: number, degrees: 0 | 90 | 180 | 270): Point {
  switch (degrees) {
    case 0:
      return { ...p };
    case 90:
      return { x: srcH - 1 - p.y, y: p.x, frame: p.frame + "@rot90" };
    case 180:
      return { x: srcW - 1 - p.x, y: srcH - 1 - p.y, frame: p.frame + "@rot180" };
    case 270:
      return { x: p.y, y: srcW - 1 - p.x, frame: p.frame + "@rot270" };
  }
}

// ---------- PNG encoding (grayscale 8-bit) ----------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(buf: Uint8Array): number {
  let c = 0xffffffff;
  for (const byte of buf) c = CRC_TABLE[(c ^ byte) & 0xff]! ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Uint8Array): Uint8Array {
  const typeBytes = Buffer.from(type, "ascii");
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([typeBytes, data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

export function encodePngGray(image: GrayImage): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(image.width, 0);
  ihdr.writeUInt32BE(image.height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 0; // color type 0 = grayscale
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  const stride = image.width + 1;
  const raw = Buffer.alloc(stride * image.height);
  for (let y = 0; y < image.height; y++) {
    raw[y * stride] = 0; // filter none
    image.pixels.subarray(y * image.width, (y + 1) * image.width).forEach((v, i) => {
      raw[y * stride + 1 + i] = v;
    });
  }
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", deflateSync(raw, { level: 9 })),
    chunk("IEND", Buffer.alloc(0)),
  ]);
}
