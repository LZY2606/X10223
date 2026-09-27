import type { GrayImage } from '../png.js';
import { offsetCurve } from '../geometry.js';
import type { PixelPoint } from '../types.js';

export interface RawLane {
  laneIndex: number;
  center: PixelPoint[];
  left: PixelPoint[];
  right: PixelPoint[];
}

/**
 * 从像素恢复泳道：
 * 1) 列方向平均亮度找到泳道脊线中心（图像自带低强度脊线）
 * 2) 在每个 y 行用局部亮度峰值细化中心 x，得到弯曲中心线
 * 3) 向两侧法向偏移得到边界
 */
export function detectLanes(img: GrayImage): RawLane[] {
  const { width, height, data } = img;
  const margin = Math.round(height * 0.04);
  const y0 = margin;
  const y1 = height - margin;

  const col = new Float64Array(width);
  for (let y = y0; y <= y1; y++) for (let x = 0; x < width; x++) col[x] += data[y * width + x];
  for (let x = 0; x < width; x++) col[x] /= y1 - y0 + 1;

  const centers = findColumnPeaks(col);
  const halfWidth = estimateHalfWidth(width, centers.length);

  const lanes: RawLane[] = centers.map((seedX, laneIndex) => {
    const center: PixelPoint[] = [];
    for (let y = y0; y <= y1; y += 2) {
      let bestX = seedX;
      let best = -Infinity;
      const win = Math.round(halfWidth * 1.1);
      for (let x = Math.max(1, seedX - win); x <= Math.min(width - 2, seedX + win); x++) {
        const score = data[y * width + x];
        if (score > best) { best = score; bestX = x; }
      }
      center.push({ x: bestX, y, frame: 'upright' });
    }
    const smooth = smoothX(center);
    const left = offsetCurve(smooth, halfWidth, -1);
    const right = offsetCurve(smooth, halfWidth, 1);
    return { laneIndex, center: smooth, left, right };
  });
  return lanes;
}

function findColumnPeaks(col: Float64Array): number[] {
  let max = 0;
  for (const v of col) max = Math.max(max, v);
  const threshold = Math.max(8, max * 0.18);
  const peaks: number[] = [];
  for (let x = 2; x < col.length - 2; x++) {
    if (col[x] >= threshold && col[x] >= col[x - 1] && col[x] >= col[x + 1] && col[x] > col[x - 2] && col[x] > col[x + 2]) {
      if (!peaks.length || x - peaks[peaks.length - 1] > 6) peaks.push(x);
      else if (col[x] > col[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = x;
    }
  }
  return peaks;
}

function estimateHalfWidth(width: number, laneCount: number): number {
  if (laneCount <= 1) return Math.round(width * 0.05);
  return Math.round(width / (laneCount + 1) * 0.42);
}

function smoothX(points: PixelPoint[]): PixelPoint[] {
  const win = 5;
  return points.map((p, i) => {
    let sx = 0;
    let n = 0;
    for (let k = Math.max(0, i - win); k <= Math.min(points.length - 1, i + win); k++) {
      sx += points[k].x;
      n++;
    }
    return { x: Math.round((sx / n) * 10) / 10, y: p.y, frame: 'upright' as const };
  });
}
