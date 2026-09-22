import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { ScenarioId } from '../shared/types.ts';
import { makeSmilePolyline, makeStraightPolyline, rotatePointClockwise, type Point } from './geometry.ts';

export const IMAGE_WIDTH = 720;
export const IMAGE_HEIGHT = 520;
export const LANE_X = [40, 140, 240, 340, 440, 540, 640] as const;

export interface SyntheticGelSpec {
  scenario: ScenarioId;
  width?: number;
  height?: number;
  ladderYs?: number[];
  sampleBands?: Record<string, Array<{ y: number; width?: number; height?: number; intensity?: number; tail?: boolean; saturate?: boolean }>>;
  laneCurves?: Record<string, Point[]>;
  rotateClockwise?: 0 | 90 | 180 | 270;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, index) => {
  let crc = index;
  for (let bit = 0; bit < 8; bit += 1) crc = crc & 1 ? 0xedb88320 ^ (crc >>> 1) : crc >>> 1;
  return crc >>> 0;
});

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type: string, data: Buffer): Buffer {
  const typeBuffer = Buffer.from(type, 'ascii');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(Buffer.concat([typeBuffer, data])));
  return Buffer.concat([length, typeBuffer, data, crc]);
}

export function encodePngGray(width: number, height: number, pixels: Uint8Array): Buffer {
  if (pixels.length !== width * height) throw new Error(`expected ${width * height} pixels, got ${pixels.length}`);
  const scanlines = Buffer.alloc((width + 1) * height);
  for (let y = 0; y < height; y += 1) {
    scanlines[y * (width + 1)] = 0;
    for (let x = 0; x < width; x += 1) scanlines[y * (width + 1) + 1 + x] = pixels[y * width + x]!;
  }
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 0;
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;
  return Buffer.concat([signature, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(scanlines, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

export function decodePngGray(png: Buffer): { width: number; height: number; pixels: Uint8Array } {
  if (!png.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    throw new Error('invalid PNG signature');
  }
  let offset = 8;
  let width = 0;
  let height = 0;
  let compressed: Buffer | undefined;
  while (offset < png.length) {
    const length = png.readUInt32BE(offset);
    const type = png.subarray(offset + 4, offset + 8).toString('ascii');
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      if (data[8] !== 8 || data[9] !== 0) throw new Error('only grayscale non-interlaced PNG is supported');
    }
    if (type === 'IDAT') compressed = compressed ? Buffer.concat([compressed, data]) : Buffer.from(data);
    offset += 12 + length;
  }
  if (!compressed) throw new Error('missing IDAT');
  const raw = inflateSync(compressed);
  const pixels = new Uint8Array(width * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (width + 1);
    if (raw[rowStart] !== 0) throw new Error('only filter type 0 is supported in synthetic PNG');
    for (let x = 0; x < width; x += 1) pixels[y * width + x] = raw[rowStart + 1 + x]!;
  }
  return { width, height, pixels };
}

function gaussian(value: number, sigma: number): number {
  return Math.exp(-(value * value) / (2 * sigma * sigma));
}

function paintBand(
  pixels: Uint8Array,
  width: number,
  height: number,
  center: Point,
  bandWidth: number,
  bandHeight: number,
  intensity: number,
  saturation = false,
  tail = false
): void {
  const radiusX = bandWidth * 3;
  const radiusY = bandHeight * (tail ? 8 : 3);
  const minX = Math.max(0, Math.floor(center.x - radiusX));
  const maxX = Math.min(width - 1, Math.ceil(center.x + radiusX));
  const minY = Math.max(0, Math.floor(center.y - radiusY));
  const maxY = Math.min(height - 1, Math.ceil(center.y + radiusY));
  for (let y = minY; y <= maxY; y += 1) {
    for (let x = minX; x <= maxX; x += 1) {
      const gx = gaussian(x - center.x, bandWidth);
      const dy = y - center.y;
      const gy = gaussian(dy, bandHeight) + (tail && dy > 0 ? 0.35 * Math.exp(-dy / 42) : 0);
      const value = Math.min(255, Math.round(24 + intensity * gx * Math.min(1, gy)));
      if (saturation && Math.abs(dy) <= bandHeight * 1.2 && Math.abs(x - center.x) <= bandWidth * 1.5) {
        pixels[y * width + x] = 255;
      } else {
        pixels[y * width + x] = Math.max(pixels[y * width + x] ?? 0, value);
      }
    }
  }
}

function laneCenterAt(laneIndex: number, y: number, curves?: Record<string, Point[]>): Point {
  const laneId = `lane-${laneIndex + 1}`;
  const curve = curves?.[laneId] ?? makeStraightPolyline(LANE_X[laneIndex]!, 20, IMAGE_HEIGHT - 20, 20);
  const index = curve.findIndex((point, cursor) => cursor < curve.length - 1 && point.y <= y && curve[cursor + 1]!.y >= y);
  if (index < 0) return curve.at(-1)!;
  const start = curve[index]!;
  const end = curve[index + 1]!;
  const ratio = (y - start.y) / (end.y - start.y || 1);
  return { x: start.x + (end.x - start.x) * ratio, y };
}

export function generateGelPng(spec: SyntheticGelSpec): { png: Buffer; width: number; height: number; sha256: string } {
  const width = spec.width ?? IMAGE_WIDTH;
  const height = spec.height ?? IMAGE_HEIGHT;
  let pixels = new Uint8Array(width * height).fill(24);
  const ladderYs = spec.ladderYs ?? [72, 108, 151, 204, 268, 335, 405, 455];
  for (const [index, y] of ladderYs.entries()) {
    paintBand(pixels, width, height, laneCenterAt(0, y, spec.laneCurves), 7, 6, 210, false, false);
  }
  const sampleBands = spec.sampleBands ?? {
    'lane-2': [{ y: 132 }, { y: 292 }],
    'lane-3': [{ y: 181, tail: true }],
    'lane-4': [{ y: 237 }],
    'lane-5': [{ y: 315 }],
    'lane-6': [{ y: 382 }],
    'lane-7': [{ y: 430 }]
  };
  for (const [laneId, bands] of Object.entries(sampleBands)) {
    const laneIndex = Number(laneId.split('-')[1]) - 1;
    for (const band of bands) paintBand(pixels, width, height, laneCenterAt(laneIndex, band.y, spec.laneCurves), band.width ?? 7, band.height ?? 6, band.intensity ?? 190, band.saturate ?? false, band.tail ?? false);
  }
  if (spec.scenario === 'overlap') {
    paintBand(pixels, width, height, laneCenterAt(3, 230), 7, 6, 195);
    paintBand(pixels, width, height, laneCenterAt(3, 246), 6.5, 6, 190);
  }
  if (spec.rotateClockwise && spec.rotateClockwise !== 0) {
    const newWidth = spec.rotateClockwise === 180 ? width : height;
    const newHeight = spec.rotateClockwise === 180 ? height : width;
    const rotated = new Uint8Array(newWidth * newHeight).fill(24);
    for (let y = 0; y < height; y += 1) {
      for (let x = 0; x < width; x += 1) {
        const target = rotatePointClockwise({ x, y }, spec.rotateClockwise, width, height);
        rotated[Math.round(target.y) * newWidth + Math.round(target.x)] = pixels[y * width + x]!;
      }
    }
    pixels = rotated;
  }
  const finalWidth = spec.rotateClockwise === 90 || spec.rotateClockwise === 270 ? height : width;
  const finalHeight = spec.rotateClockwise === 90 || spec.rotateClockwise === 270 ? width : height;
  const png = encodePngGray(finalWidth, finalHeight, pixels);
  return { png, width: finalWidth, height: finalHeight, sha256: createHash('sha256').update(png).digest('hex') };
}

export function makeDefaultLaneCurves(scenario: ScenarioId): Record<string, Point[]> {
  const curves: Record<string, Point[]> = {};
  LANE_X.forEach((x, index) => {
    curves[`lane-${index + 1}`] = index === 2 && scenario === 'smile'
      ? makeSmilePolyline(x, 20, IMAGE_HEIGHT - 20, 18, 20)
      : makeStraightPolyline(x, 20, IMAGE_HEIGHT - 20, 20);
  });
  return curves;
}

export function imageDigest(png: Buffer): string {
  return createHash('sha256').update(png).digest('hex');
}
