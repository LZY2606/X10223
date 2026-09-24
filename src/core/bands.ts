import { fail, ok, type Outcome, type Diagnostic } from '../shared/diagnostic';
import type { ParamSet } from '../shared/types';
import { sampleBilinear, type GrayRaster } from './png';
import { curveX, type LaneCurve } from './lanes';

export interface DetectedBand {
  centerY: number;
  centerX: number;
  halfHeightPx: number;
  halfWidthPx: number;
  peakIntensity: number;   // 0..1
  saturated: boolean;
  overlapping: boolean;
  trailing: boolean;
}

export interface DetectionResult {
  bands: DetectedBand[];
  diagnostics: Diagnostic[];
}

/**
 * 沿泳道曲线做一维条带检测。
 * 资源预算：像素扫描总量与泳道数受限，耗尽 => resource-budget（与格式损坏、语义无解严格区分）。
 */
export function detectBands(
  raster: GrayRaster,
  lane: LaneCurve,
  laneIndex: number,
  params: ParamSet,
): Outcome<DetectionResult> {
  const diagnostics: Diagnostic[] = [];
  const pixels = raster.width * raster.height;
  if (pixels > params.detectionBudget.maxPixels) {
    return fail('resource-budget', [{
      severity: 'error', code: 'budget/pixels-exceeded',
      message: `图像像素 ${pixels} 超过预算 ${params.detectionBudget.maxPixels}`,
      path: `lanes[${laneIndex}]`,
    }]);
  }
  if (laneIndex >= params.detectionBudget.maxLanes) {
    return fail('resource-budget', [{
      severity: 'error', code: 'budget/lanes-exceeded',
      message: `泳道序号 ${laneIndex} 超过预算 ${params.detectionBudget.maxLanes}`,
      path: `lanes[${laneIndex}]`,
    }]);
  }

  const y0 = Math.ceil(lane.yTop), y1 = Math.floor(lane.yBottom);
  const profile: number[] = [];
  for (let y = y0; y <= y1; y++) {
    const cx = curveX(lane, y);
    // 跨泳道宽度取 5 点平均，抑制噪声
    let acc = 0;
    for (const dx of [-4, -2, 0, 2, 4]) acc += sampleBilinear(raster, cx + dx, y);
    profile.push(acc / 5 / 255);
  }
  const n = profile.length;
  if (n < 5) {
    return fail('invalid-input', [{
      severity: 'error', code: 'detect/lane-too-short',
      message: '泳道纵向跨度不足，无法检测条带',
      path: `lanes[${laneIndex}]`,
    }]);
  }

  // 自适应阈值：中位数 + 3 * MAD
  const sorted = [...profile].sort((a, b) => a - b);
  const median = sorted[Math.floor(n / 2)];
  const mad = sorted.map((v) => Math.abs(v - median)).sort((a, b) => a - b)[Math.floor(n / 2)];
  const threshold = Math.min(0.9, median + Math.max(3 * mad, 0.08));

  const bands: DetectedBand[] = [];
  let i = 1;
  while (i < n - 1) {
    if (profile[i] >= threshold && profile[i] >= profile[i - 1] && profile[i] >= profile[i + 1]) {
      // 峰平台：取质心
      let j = i;
      while (j + 1 < n && profile[j + 1] >= threshold) j++;
      let wsum = 0, ysum = 0, peak = 0;
      for (let k = i; k <= j; k++) {
        const w = profile[k] - threshold + 0.001;
        wsum += w; ysum += w * k;
        peak = Math.max(peak, profile[k]);
      }
      const cy = y0 + ysum / wsum;
      // 半高宽
      let up = cy - y0, down = cy - y0;
      const half = threshold + (peak - threshold) / 2;
      while (up > 0 && profile[Math.floor(up)] > half) up -= 0.5;
      while (down < n - 1 && profile[Math.floor(down)] > half) down += 0.5;
      const halfHeight = Math.max(1, (down - up) / 2);
      // 拖尾：下降沿显著长于上升沿
      const trailing = (down - (cy - y0)) > 2.2 * ((cy - y0) - up) && (down - (cy - y0)) > 6;
      bands.push({
        centerY: cy,
        centerX: curveX(lane, cy),
        halfHeightPx: halfHeight,
        halfWidthPx: 8,
        peakIntensity: peak,
        saturated: peak >= params.saturationThreshold,
        overlapping: false,
        trailing,
      });
      i = j + 1;
    } else {
      i++;
    }
  }

  // 重叠判定：相邻峰中心距小于预算间隔 => 双方只能作为候选
  for (let k = 0; k + 1 < bands.length; k++) {
    const gap = bands[k + 1].centerY - bands[k].centerY;
    if (gap < params.overlapMinSeparationPx + bands[k].halfHeightPx + bands[k + 1].halfHeightPx) {
      bands[k].overlapping = true;
      bands[k + 1].overlapping = true;
      diagnostics.push({
        severity: 'warning', code: 'detect/overlap',
        message: `泳道 ${laneIndex} 在 y≈${Math.round((bands[k].centerY + bands[k + 1].centerY) / 2)}px 处两条带重叠，仅能作为候选`,
        path: `lanes[${laneIndex}].bands`,
        position: { pixel: { x: bands[k].centerX, y: bands[k].centerY } },
      });
    }
  }
  return ok({ bands, diagnostics });
}
