import type { GrayImage } from '../png.js';
import { clamp } from '../geometry.js';
import { laneCenterX, makeRng, type GelScene } from './scene.js';

/** 饱和平台灰度（检测器据此判定饱和区） */
export const SAT_CAP = 250;

/**
 * 由场景模型确定性渲染 8-bit 灰度凝胶。
 * - 泳道中心线留有低强度脊线，便于从图像本身恢复弯曲泳道（像素级来源）
 * - saturate=true 的条带渲染为平顶；tail>1 产生拖尾；相邻条带自然重叠
 */
export function renderScene(scene: GelScene): GrayImage {
  const { width, height } = scene;
  const data = new Uint8Array(width * height);
  const rng = makeRng(scene.seed);
  const cx = new Map<number, Float64Array>();
  for (const lane of scene.lanes) {
    const arr = new Float64Array(height + 1);
    for (let y = scene.topY; y <= scene.bottomY; y++) arr[y] = laneCenterX(scene, lane, y);
    cx.set(lane.index, arr);
  }

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = scene.background;
      for (const lane of scene.lanes) {
        if (y < scene.topY - 2 || y > scene.bottomY + 2) continue;
        const cxx = cx.get(lane.index)![y] ?? cx.get(lane.index)![clamp(y, scene.topY, scene.bottomY)];
        // 泳道脊线（低强度），用于恢复弯曲中心线
        const transverse = Math.exp(-((x - cxx) ** 2) / (2 * (lane.halfWidth * 0.55) ** 2));
        v += 5 * transverse;
        if (y >= scene.topY && y <= scene.bottomY) {
          for (const band of lane.bands) {
            if (band.missingInImage) continue;
            const cy = scene.topY + band.m * (scene.bottomY - scene.topY);
            const dy = y - cy;
            const sigma = band.sigma * (dy > 0 ? band.tail : 1);
            const along = Math.exp(-(dy * dy) / (2 * sigma * sigma));
            const across = Math.exp(-((x - cxx) ** 2) / (2 * (lane.halfWidth * 0.62) ** 2));
            let add = band.intensity * along * across;
            if (band.saturate) add = Math.min(SAT_CAP, add * 1.6);
            v += add;
          }
        }
      }
      const noise = (rng() - 0.5) * 2 * scene.noiseSigma;
      data[y * width + x] = clamp(Math.round(v + noise), 0, 255);
    }
  }
  return { width, height, data };
}
