import { encodePng } from './png.js';
import { pointAt } from './geometry.js';
import type { Vec } from '../shared/types.js';

export interface GroundTruthBand {
  laneIndex: number;
  s: number;
  amplitude: number;
  saturated: boolean;
  smear: boolean;
}

export interface GelSpec {
  width: number;
  height: number;
  laneX: number[];
  top: number;
  bottom: number;
  smileAmp: number[]; // 每泳道微笑位移(px)
  bendAmp: number[]; // 每泳道 S 形弯曲(px)
  bands: GroundTruthBand[];
  seed: number;
}

export interface RenderedGel {
  png: Uint8Array;
  gray: Uint8Array;
  width: number;
  height: number;
  lanes: { laneIndex: number; polyline: Vec[] }[];
  truth: GroundTruthBand[];
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SIGMA_ALONG = 5.2;
const SIGMA_ACROSS = 8.5;
const BG = 16;

export function buildLanes(spec: GelSpec): { laneIndex: number; polyline: Vec[] }[] {
  const L = spec.bottom - spec.top;
  return spec.laneX.map((x0, k) => {
    const polyline: Vec[] = [];
    const steps = Math.max(60, Math.round(L));
    for (let i = 0; i <= steps; i++) {
      const u = i / steps;
      const y = spec.top + u * L - spec.smileAmp[k] * 4 * u * (1 - u);
      const x = x0 + spec.bendAmp[k] * Math.sin(Math.PI * u);
      polyline.push({ x, y });
    }
    return { laneIndex: k, polyline };
  });
}

export function renderGel(spec: GelSpec): RenderedGel {
  const { width, height } = spec;
  const rand = mulberry32(spec.seed);
  const img = new Float32Array(width * height).fill(BG);
  const lanes = buildLanes(spec);

  const put = (x: number, y: number, v: number) => {
    const xi = Math.round(x), yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
    img[yi * width + xi] += v;
  };

  for (const band of spec.bands) {
    const lane = lanes[band.laneIndex].polyline;
    const { point } = pointAt(lane, band.s);
    const amp = band.saturated ? 320 : band.amplitude;
    const smearTail = band.smear ? 26 : 0;
    const radius = 22 + smearTail;
    for (let dy = -radius; dy <= radius; dy++) {
      for (let dx = -16; dx <= 16; dx++) {
        const along = -dy; // +s 方向朝下
        let g = Math.exp(-(dx * dx) / (2 * SIGMA_ACROSS * SIGMA_ACROSS));
        g *= Math.exp(-(along * along) / (2 * SIGMA_ALONG * SIGMA_ALONG));
        if (band.smear && along < 0) {
          g *= Math.exp(along / 14); // 向上迁移方向的拖尾被压低，向下留尾
        }
        if (band.smear && along > -4) {
          g = Math.max(g, 0.45 * Math.exp(-Math.max(0, along + 4) / 18) * Math.exp(-(dx * dx) / (2 * 11 * 11)));
        }
        put(point.x + dx, point.y + dy, amp * g);
      }
    }
  }

  const gray = new Uint8Array(width * height);
  for (let i = 0; i < img.length; i++) {
    const noise = (rand() - 0.5) * 5;
    gray[i] = Math.max(0, Math.min(255, Math.round(img[i] + noise)));
  }
  const rgba = new Uint8Array(width * height * 4);
  for (let i = 0; i < gray.length; i++) {
    rgba[i * 4] = gray[i]; rgba[i * 4 + 1] = gray[i]; rgba[i * 4 + 2] = gray[i]; rgba[i * 4 + 3] = 255;
  }
  return { png: encodePng({ width, height, channels: 4, data: rgba }), gray, width, height, lanes, truth: spec.bands };
}

export function rotateGrayCW(gray: Uint8Array, w: number, h: number): { gray: Uint8Array; w: number; h: number } {
  // 顺时针 90 度：new(x', y') = old(h-1-y, x)? 采用 (x'=h-1-y, y'=x) 的逆采样
  const out = new Uint8Array(w * h);
  const nw = h, nh = w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = h - 1 - y, ny = x;
      out[ny * nw + nx] = gray[y * w + x];
    }
  }
  return { gray: out, w: nw, h: nh };
}

export function grayToPng(gray: Uint8Array, w: number, h: number): Uint8Array {
  const rgba = new Uint8Array(w * h * 4);
  for (let i = 0; i < gray.length; i++) {
    rgba[i * 4] = gray[i]; rgba[i * 4 + 1] = gray[i]; rgba[i * 4 + 2] = gray[i]; rgba[i * 4 + 3] = 255;
  }
  return encodePng({ width: w, height: h, channels: 4, data: rgba });
}
