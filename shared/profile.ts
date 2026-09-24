// 沿弯曲 lane 提取强度剖面：强度按弧长 s 积分，而非按像素行 y。
import type { RasterContent, Vec2 } from "./types";
import { buildCurve, interpAt } from "./curveMath";

export { buildCurve };

export interface Profile {
  s: number[];
  intensity: number[];
}

export function extractProfile(raster: RasterContent, center: Vec2[], halfWidth: number): Profile {
  const curve = buildCurve(center);
  const total = curve.cumulative[curve.cumulative.length - 1];
  const STEPS = Math.max(60, Math.ceil(total));
  const s: number[] = [];
  const intensity: number[] = [];
  for (let i = 0; i <= STEPS; i++) {
    const si = (total * i) / STEPS;
    const c = interpAt(curve, si);
    const eps = 0.75;
    const a = interpAt(curve, Math.max(0, si - eps));
    const b = interpAt(curve, Math.min(total, si + eps));
    const tx = b.x - a.x;
    const ty = b.y - a.y;
    const tn = Math.hypot(tx, ty) || 1;
    const nx = -ty / tn;
    const ny = tx / tn;
    let sum = 0;
    let count = 0;
    for (let off = -halfWidth; off <= halfWidth; off += 1) {
      const px = Math.round(c.x + nx * off);
      const py = Math.round(c.y + ny * off);
      if (px >= 0 && px < raster.width && py >= 0 && py < raster.height) {
        sum += raster.grayscale[py * raster.width + px];
        count++;
      }
    }
    s.push(si);
    intensity.push(count ? sum / count : 0);
  }
  return { s, intensity };
}

export function percentile(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.round((p / 100) * (sorted.length - 1))));
  return sorted[idx];
}
