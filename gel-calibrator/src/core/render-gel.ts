// Deterministic synthetic gel renderer (pngjs, no canvas dependency).
// Produces a grayscale gel with a dark background and bright bands so the
// bundled offline case pack is real domain imagery, not a generic table.
import { PNG } from 'pngjs';

export interface DrawnBand {
  laneIndex: number;
  x: number; y: number;
  /** 0..1 intensity; > satThreshold is saturated (clipped flat region). */
  intensity: number;
  ry: number;               // vertical half-size
  saturated?: boolean;
  overlapWith?: number;     // index of a sibling band this merges with
  smear?: boolean;          // vertical tail
}

export interface RenderSpec {
  width: number;
  height: number;
  laneCenters: number[];
  laneHalfWidth: number;
  bands: DrawnBand[];
  /** lane centerline bows as cosine smile: y = y0 + amp*cos(pi*x_rel) style. */
  laneSmileAmplitude?: number[];
  seed?: number;
}

const clamp = (v: number, lo = 0, hi = 255) => Math.max(lo, Math.min(hi, v));

/** Curved lane centerline polyline for lane i (vertical, with a smile bow). */
export function laneCenterline(
  spec: RenderSpec, laneIndex: number, stepPx = 6,
): Array<{ x: number; y: number }> {
  const cx = spec.laneCenters[laneIndex]!;
  const amp = spec.laneSmileAmplitude?.[laneIndex] ?? 0;
  const pts: Array<{ x: number; y: number }> = [];
  for (let y = 0; y <= spec.height; y += stepPx) {
    const rel = y / spec.height;                 // 0 top .. 1 bottom
    const bow = amp * Math.sin(Math.PI * rel);   // 0 at ends, max in middle
    pts.push({ x: Math.round(cx + bow), y });
  }
  return pts;
}

/** x position of lane centerline at a given y. */
export function laneXAtY(spec: RenderSpec, laneIndex: number, y: number): number {
  const cx = spec.laneCenters[laneIndex]!;
  const amp = spec.laneSmileAmplitude?.[laneIndex] ?? 0;
  return cx + amp * Math.sin(Math.PI * (y / spec.height));
}

export function renderGel(spec: RenderSpec): PNG {
  const png = new PNG({ width: spec.width, height: spec.height });
  const bg = 24;
  for (let y = 0; y < spec.height; y++) {
    for (let x = 0; x < spec.width; x++) {
      const idx = (spec.width * y + x) * 4;
      const v = bg + 4 * Math.sin(x * 0.13) * Math.sin(y * 0.07);
      png.data[idx] = clamp(v); png.data[idx + 1] = clamp(v); png.data[idx + 2] = clamp(v);
      png.data[idx + 3] = 255;
    }
  }
  for (const band of spec.bands) {
    const cx = laneXAtY(spec, band.laneIndex, band.y);
    const rx = spec.laneHalfWidth - 2;
    const satValue = 255;
    for (let dy = -band.ry * (band.smear ? 3 : 1); dy <= band.ry; dy++) {
      const tailFade = band.smear && dy > band.ry ? Math.max(0, 1 - (dy - band.ry) / (band.ry * 2)) : 1;
      for (let dx = -rx; dx <= rx; dx++) {
        const nx = dx / rx, ny = dy / band.ry;
        const fall = Math.exp(-(nx * nx * 2.2 + ny * ny * 2.2));
        let lum = bg + (230 * band.intensity * fall * tailFade);
        if (band.saturated && nx * nx + ny * ny < 0.55) lum = satValue; // flat clipping plateau
        const x = Math.round(cx + band.laneIndex * 0) + Math.round(dx);
        const yy = band.y + Math.round(dy);
        if (x < 0 || x >= spec.width || yy < 0 || yy >= spec.height) continue;
        const idx = (spec.width * yy + x) * 4;
        const c = clamp(Math.max(png.data[idx]!, lum));
        png.data[idx] = c; png.data[idx + 1] = c; png.data[idx + 2] = c;
      }
    }
  }
  return png;
}

export function pngToBase64(png: PNG): string {
  return PNG.sync.write(png).toString('base64');
}

export function rotate90Base64(base64: string, times: 1 | 2 | 3): { base64: string; width: number; height: number } {
  let cur = PNG.sync.read(Buffer.from(base64, 'base64')) as unknown as PNG;
  for (let t = 0; t < times; t++) cur = rotateCW(cur);
  return { base64: PNG.sync.write(cur).toString('base64'), width: cur.width, height: cur.height };
}

function rotateCW(src: PNG): PNG {
  const out = new PNG({ width: src.height, height: src.width }) as unknown as PNG;
  for (let y = 0; y < src.height; y++) {
    for (let x = 0; x < src.width; x++) {
      const si = (src.width * y + x) * 4;
      const dx = src.height - 1 - y, dy = x;
      const di = (out.width * dy + dx) * 4;
      out.data[di] = src.data[si]!; out.data[di + 1] = src.data[si + 1]!;
      out.data[di + 2] = src.data[si + 2]!; out.data[di + 3] = 255;
    }
  }
  return out;
}
