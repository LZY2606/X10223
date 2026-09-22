import { PNG } from 'pngjs';
import type { PixelPoint } from '../src/shared/types.js';

export interface RenderBand {
  s: number;                 // 沿中心线自井口的弧长 px
  w?: number;                // 沿切线半宽
  saturated?: boolean;
  brightness?: number;       // 0..150
}
export interface RenderLane {
  centerAtS: (s: number) => PixelPoint; // s=0 在井口
  length: number;
  halfWidth: number;
  bands: RenderBand[];
}
export interface GelSpec { width: number; height: number; lanes: RenderLane[] }

function tangent(lane: RenderLane, s: number): { tx: number; ty: number } {
  const a = lane.centerAtS(s - 1), b = lane.centerAtS(s + 1);
  let tx = b.x - a.x, ty = b.y - a.y;
  const l = Math.hypot(tx, ty) || 1;
  return { tx: tx / l, ty: ty / l };
}

export function renderGel(spec: GelSpec): PNG {
  const png = new PNG({ width: spec.width, height: spec.height });
  for (let y = 0; y < spec.height; y++) {
    for (let x = 0; x < spec.width; x++) {
      const noise = (Math.sin(x * 12.9898 + y * 78.233) * 43758.5453) % 1;
      const v = 30 + Math.floor(Math.abs(noise) * 7) + Math.floor((y / spec.height) * 5);
      const idx = (y * spec.width + x) * 4;
      png.data[idx] = png.data[idx + 1] = png.data[idx + 2] = v;
      png.data[idx + 3] = 255;
    }
  }
  for (const lane of spec.lanes) {
    for (let s = 4; s < lane.length - 2; s += 2) {
      const c = lane.centerAtS(s);
      const t = tangent(lane, s);
      const nx = -t.ty, ny = t.tx;
      for (let off = -lane.halfWidth; off <= lane.halfWidth; off++) {
        const x = Math.round(c.x + nx * off), y = Math.round(c.y + ny * off);
        if (x < 0 || y < 0 || x >= spec.width || y >= spec.height) continue;
        const idx = (y * spec.width + x) * 4;
        png.data[idx] = Math.min(255, png.data[idx] + 5);
        png.data[idx + 1] = Math.min(255, png.data[idx + 1] + 5);
        png.data[idx + 2] = Math.min(255, png.data[idx + 2] + 5);
      }
    }
    for (const band of lane.bands) {
      const w = band.w ?? 7;
      for (let ds = -w - 3; ds <= w + 3; ds++) {
        const s = band.s + ds;
        if (s < 0 || s > lane.length) continue;
        const c = lane.centerAtS(s);
        const tan = tangent(lane, s);
        const nx = -tan.ty, ny = tan.tx;
        for (let off = -lane.halfWidth; off <= lane.halfWidth; off++) {
          const x = Math.round(c.x + nx * off), y = Math.round(c.y + ny * off);
          if (x < 0 || y < 0 || x >= spec.width || y >= spec.height) continue;
          const g = Math.exp(-(ds * ds) / (2 * (w / 2.2) ** 2))
            * Math.exp(-(off * off) / (2 * (lane.halfWidth * 0.72) ** 2));
          const idx = (y * spec.width + x) * 4;
          if (band.saturated && Math.abs(ds) <= 1.2 && Math.abs(off) <= lane.halfWidth * 0.55) {
            png.data[idx] = png.data[idx + 1] = png.data[idx + 2] = 255;
          } else {
            const add = Math.round(g * (band.brightness ?? 150));
            png.data[idx] = Math.min(255, png.data[idx] + add);
            png.data[idx + 1] = Math.min(255, png.data[idx + 1] + add);
            png.data[idx + 2] = Math.min(255, png.data[idx + 2] + add);
          }
        }
      }
    }
  }
  return png;
}

// 直线泳道
export function straightLane(x0: number, y0: number, length: number, halfWidth: number, bands: RenderBand[]): RenderLane {
  return { length, halfWidth, bands, centerAtS: (s) => ({ x: x0, y: y0 + s }) };
}

// 微笑弯曲泳道：水平方向随 s 呈正弦偏移（同 y 高度不同道的 s 不同）
export function smilingLane(x0: number, y0: number, length: number, halfWidth: number, amp: number, bands: RenderBand[]): RenderLane {
  return {
    length, halfWidth, bands,
    centerAtS: (s) => ({ x: Math.round(x0 + amp * Math.sin((s / length) * Math.PI)), y: y0 + s }),
  };
}
