import { qty, type Qty } from './units';

/** Immutable source materials. Pixel-level provenance is preserved on every entry. */

export interface PxPoint {
  x: Qty<'px'>;
  y: Qty<'px'>;
}

export interface ImageMaterial {
  kind: 'image';
  id: string;
  width: Qty<'px'>;
  height: Qty<'px'>;
  orientationDeg: Qty<'deg'>; // capture orientation of the raw pixel matrix
  exposure: { timeMs: Qty<'ms'>; gain: number };
  pixelsB64: string; // raw grayscale 8-bit, row-major, in capture orientation
  capturedAt: string; // ISO-8601 time basis
}

export interface LadderBand {
  bandIndex: number;
  bp: Qty<'bp'>;
  center?: PxPoint; // normalized frame; absent when the band is missing on the gel
  captureCenter?: PxPoint; // raw capture frame, kept when orientation != 0
  missing?: boolean;
}

export interface LadderMaterial {
  kind: 'ladder';
  id: string;
  laneId: string;
  nominal: LadderBand[];
}

export interface LaneDef {
  laneId: string;
  index: number;
  centerline: PxPoint[]; // pixel-level source, top to bottom
  halfWidthPx: number;
}

export interface LaneBoundariesMaterial {
  kind: 'lanes';
  id: string;
  lanes: LaneDef[];
}

export interface BandCenter {
  bandKey: string;
  center: PxPoint; // normalized-frame pixel source
  rawCenter: PxPoint; // capture-frame pixel source (pre-normalization)
  peakIntensity: Qty<'gray'>;
  widthPx: number;
  upWidthPx: number;
  downWidthPx: number;
  flags: string[]; // 'saturated' | 'smear' | 'overlap'
  overlapGroup?: string;
}

export interface BandCentersMaterial {
  kind: 'bands';
  id: string;
  laneId: string;
  centers: BandCenter[];
}

export type Material = ImageMaterial | LadderMaterial | LaneBoundariesMaterial | BandCentersMaterial;

export const NORM_BASIS = 'gel-norm:origin-top-left:wells-top:px';

/** Rotate a capture-frame point into the normalized frame given capture orientation. */
export function normalizePoint(
  x: number,
  y: number,
  width: number,
  height: number,
  orientationDeg: number,
): { x: number; y: number } {
  const o = ((orientationDeg % 360) + 360) % 360;
  if (o === 0) return { x, y };
  if (o === 90) return { x: y, y: width - 1 - x }; // captured rotated CW -> rotate CCW back
  if (o === 180) return { x: width - 1 - x, y: height - 1 - y };
  if (o === 270) return { x: height - 1 - y, y: x };
  throw new Error(`unsupported orientation ${orientationDeg}`);
}

export function denormalizePoint(
  x: number,
  y: number,
  width: number,
  height: number,
  orientationDeg: number,
): { x: number; y: number } {
  const o = ((orientationDeg % 360) + 360) % 360;
  if (o === 0) return { x, y };
  if (o === 90) return { x: width - 1 - y, y: x };
  if (o === 180) return { x: width - 1 - x, y: height - 1 - y };
  if (o === 270) return { x: y, y: height - 1 - x };
  throw new Error(`unsupported orientation ${orientationDeg}`);
}

/** Derived-layer normalization: raw pixels stay untouched in the material. */
export function normalizePixels(img: ImageMaterial): { width: number; height: number; pixels: Uint8Array } {
  const w = img.width.value;
  const h = img.height.value;
  const src = Buffer.from(img.pixelsB64, 'base64');
  const o = ((img.orientationDeg.value % 360) + 360) % 360;
  if (o === 0) return { width: w, height: h, pixels: new Uint8Array(src) };
  const nw = o === 90 || o === 270 ? h : w;
  const nh = o === 90 || o === 270 ? w : h;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const p = denormalizePoint(x, y, w, h, o);
      out[y * nw + x] = src[Math.round(p.y) * w + Math.round(p.x)];
    }
  }
  return { width: nw, height: nh, pixels: out };
}

export function pxPoint(x: number, y: number, basis: string, raw?: string): PxPoint {
  return { x: qty(x, 'px', basis, raw), y: qty(y, 'px', basis, raw) };
}
