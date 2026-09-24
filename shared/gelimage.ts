export interface GelImage {
  width: number;
  height: number;
  gray: Uint8Array;
}

export interface LaneBandSpec {
  r: number;
  intensity: number;
  sigma: number;
}

export interface LaneSpec {
  laneId: string;
  x: number;
  width: number;
  bands: LaneBandSpec[];
}

export interface RenderOptions {
  width: number;
  height: number;
  topOffset: number;
  lanes: LaneSpec[];
  smileAmp: number;
  noise: number;
  seed: number;
}

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function smileOffset(smileAmp: number, x: number, width: number): number {
  const u = (x - width / 2) / (width / 2);
  return smileAmp * u * u;
}

export function renderGel(opts: RenderOptions): GelImage {
  const { width, height, topOffset, lanes, smileAmp, noise, seed } = opts;
  const gray = new Uint8Array(width * height);
  const rand = mulberry32(seed);
  for (const lane of lanes) {
    const dy = smileOffset(smileAmp, lane.x, width);
    for (const band of lane.bands) {
      const cy = topOffset + band.r + dy;
      const cx = lane.x;
      const sx = Math.max(2.2, lane.width / 6);
      const sy = band.sigma;
      const x0 = Math.max(0, Math.floor(cx - 4 * sx));
      const x1 = Math.min(width - 1, Math.ceil(cx + 4 * sx));
      const y0 = Math.max(0, Math.floor(cy - 4 * sy));
      const y1 = Math.min(height - 1, Math.ceil(cy + 4 * sy));
      for (let y = y0; y <= y1; y++) {
        for (let x = x0; x <= x1; x++) {
          const dx = (x - cx) / sx;
          const dyy = (y - cy) / sy;
          const v = band.intensity * Math.exp(-0.5 * (dx * dx + dyy * dyy));
          const idx = y * width + x;
          const sum = gray[idx]! + v;
          gray[idx] = sum > 255 ? 255 : (sum as number);
        }
      }
    }
  }
  if (noise > 0) {
    for (let i = 0; i < gray.length; i++) {
      const n = gray[i]! + Math.floor(rand() * noise);
      gray[i] = n > 255 ? 255 : n;
    }
  }
  return { width, height, gray };
}

export function rotate90(img: GelImage): GelImage {
  const { width, height, gray } = img;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const nx = height - 1 - y;
      const ny = x;
      out[ny * height + nx] = gray[y * width + x]!;
    }
  }
  return { width: height, height: width, gray: out };
}
