// 泳道检测：纵向暗度投影找候选中线，再沿迁移方向做弯曲追踪（支持“微笑”）。
// 输出保留每条折线的每个像素级来源点；并量化弯曲度。
import { D, diag } from '../diagnostics.js';
import type { Diagnostic } from '../types.js';

export interface DetectedLaneShape {
  laneIndex: number;
  centerline: Array<{ x: number; y: number }>;
  leftEdge: Array<{ x: number; y: number }>;
  rightEdge: Array<{ x: number; y: number }>;
  halfWidthPx: number;
  curvaturePx: number; // 中线相对直线的最大偏移
  meanDarkness: number;
}

export interface DetectLanesResult {
  lanes: DetectedLaneShape[];
  smileDetected: boolean;
  diagnostics: Diagnostic[];
}

export function detectLanes(
  absorbance: Float32Array,
  width: number,
  height: number,
  params: { laneMinSeparationPx: number },
): DetectLanesResult {
  const diagnostics: Diagnostic[] = [];
  // 列投影：忽略顶部加样口区（前 10%）
  const top = Math.round(height * 0.1);
  const bottom = Math.round(height * 0.97);
  const col = new Float32Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    let n = 0;
    for (let y = top; y < bottom; y++) {
      sum += absorbance[y * width + x]!;
      n++;
    }
    col[x] = sum / Math.max(1, n);
  }
  const mean = col.reduce((a, b) => a + b, 0) / width;
  const sd =
    Math.sqrt(col.reduce((a, b) => a + (b - mean) ** 2, 0) / width) || 1e-6;

  const threshold = mean + 0.6 * sd;
  const peaks: Array<{ x: number; v: number }> = [];
  for (let x = 2; x < width - 2; x++) {
    if (col[x]! > threshold && col[x]! >= col[x - 1]! && col[x]! > col[x + 1]!) {
      const last = peaks[peaks.length - 1];
      if (!last || x - last.x >= params.laneMinSeparationPx) peaks.push({ x, v: col[x]! });
    } else if (last && col[x]! > last.v && x - last.x < params.laneMinSeparationPx) {
      last.x = x;
      last.v = col[x]!;
    }
  }
  peaks.sort((a, b) => a.x - b.x);

  const halfWidth = Math.max(8, Math.round(params.laneMinSeparationPx * 0.55));
  const lanes: DetectedLaneShape[] = [];
  let smileDetected = false;
  const step = 8;

  peaks.forEach((peak, idx) => {
    const centerline: Array<{ x: number; y: number }> = [];
    let darknessSum = 0;
    let darknessN = 0;
    for (let y = top; y < bottom; y += step) {
      let bestX = peak.x;
      let best = -Infinity;
      const x0 = Math.max(2, peak.x - halfWidth);
      const x1 = Math.min(width - 3, peak.x + halfWidth);
      for (let x = x0; x <= x1; x++) {
        let s = absorbance[y * width + x]!;
        if (y + 1 < height) s += absorbance[(y + 1) * width + x]!;
        if (y > 0) s += absorbance[(y - 1) * width + x]!;
        if (s > best) {
          best = s;
          bestX = x;
        }
      }
      centerline.push({ x: bestX, y });
      for (let x = x0; x <= x1; x++) {
        darknessSum += absorbance[y * width + x]!;
        darknessN++;
      }
    }
    // 末端补点
    centerline.push({ x: peak.x, y: bottom - 1 });

    const xs = centerline.map((p) => p.x);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const curvaturePx = maxX - minX;
    if (curvaturePx >= 4) smileDetected = true;

    const leftEdge = centerline.map((p) => ({ x: p.x - halfWidth, y: p.y }));
    const rightEdge = centerline.map((p) => ({ x: p.x + halfWidth, y: p.y }));
    lanes.push({
      laneIndex: idx + 1,
      centerline,
      leftEdge,
      rightEdge,
      halfWidthPx: halfWidth,
      curvaturePx,
      meanDarkness: darknessSum / Math.max(1, darknessN),
    });
  });

  if (smileDetected) {
    diagnostics.push(
      diag(D.SMILE_DETECTED, 'warning', '检测到泳道弯曲（“微笑”）：同一像素高度不等于同一迁移距离，局部标尺须带有效区域', '/image'),
    );
  }
  return { lanes, smileDetected, diagnostics };
}
