import type { PixelPoint } from '../shared/types';
import type { RawImage } from './png';
import { catmullRom, arcLengthTable, pointAtArcLength } from './geometry';
import { GelFailure, diag } from './errors';
import { PARAM_VERSIONS, DEFAULT_PARAMS } from './params';

/** 像素预算：资源耗尽是独立结果，绝不与格式损坏/语义无解混淆 */
export interface Budget {
  pixels: number;
  used: number;
}

export function checkBudget(budget: Budget, add: number) {
  budget.used += add;
  if (budget.used > budget.pixels) {
    throw new GelFailure('RESOURCE_BUDGET_EXHAUSTED', [
      diag(
        'RESOURCE_BUDGET_EXHAUSTED',
        'error',
        `资源预算耗尽：已处理 ${budget.used} 像素，预算 ${budget.pixels}`,
        {}
      ),
    ]);
  }
}

export function grayAt(img: RawImage, x: number, y: number): number {
  const xi = x | 0;
  const yi = y | 0;
  if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return 0;
  if (img.channels === 1) return img.data[yi * img.width + xi];
  const i = (yi * img.width + xi) * 3;
  return 0.299 * img.data[i] + 0.587 * img.data[i + 1] + 0.114 * img.data[i + 2];
}

export interface DetectedLane {
  ordinal: number;
  controlPoints: { x: number; y: number }[];
  halfWidthPx: number;
  poly: { x: number; y: number }[];
  table: number[];
  totalLength: number;
  frontTopT: number;
  meanIntensity: number;
  boundaryXs: number[];
  sampledRows: number;
}

/**
 * 泳道检测：
 * 1) 列方向平均亮度 -> 亮条
 * 2) 每个亮条沿行跟踪局部中心（弯曲 lane 自然被跟随）
 */
export function detectLanes(img: RawImage, budget: Budget, isLadderIndex = 0): DetectedLane[] {
  checkBudget(budget, img.width * img.height);
  const params = DEFAULT_PARAMS[PARAM_VERSIONS.laneDetection].values;
  const stripProm = params.stripProminence as number;
  const minW = params.minStripWidthPx as number;

  const colMean = new Float64Array(img.width);
  const sampleRows: number[] = [];
  for (let y = 30; y < img.height - 20; y += 4) sampleRows.push(y);
  for (const y of sampleRows) {
    for (let x = 0; x < img.width; x++) colMean[x] += grayAt(img, x, y);
  }
  for (let x = 0; x < img.width; x++) colMean[x] /= sampleRows.length;

  let bg = 255;
  let peak = 0;
  for (let x = 0; x < img.width; x++) {
    bg = Math.min(bg, colMean[x]);
    peak = Math.max(peak, colMean[x]);
  }
  const threshold = bg + (peak - bg) * stripProm;

  const strips: { x0: number; x1: number; cx: number }[] = [];
  let x = 0;
  while (x < img.width) {
    if (colMean[x] > threshold) {
      let x1 = x;
      let sum = 0;
      let wsum = 0;
      while (x1 < img.width && colMean[x1] > threshold * 0.8) {
        sum += colMean[x1] * x1;
        wsum += colMean[x1];
        x1++;
      }
      if (x1 - x >= minW) strips.push({ x0: x, x1, cx: sum / wsum });
      x = x1;
    } else x++;
  }
  strips.sort((a, b) => a.cx - b.cx);

  const laneParams = DEFAULT_PARAMS[PARAM_VERSIONS.laneDetection].values;
  const maxGap = laneParams.maxGapMergePx as number;
  const merged: typeof strips = [];
  for (const s of strips) {
    const last = merged[merged.length - 1];
    if (last && s.cx - last.cx < maxGap) {
      last.x1 = s.x1;
      last.cx = (last.cx + s.cx) / 2;
    } else merged.push({ ...s });
  }

  const yRows = [];
  for (let y = 34; y <= img.height - 40; y += 26) yRows.push(y);

  return merged.map((strip, ordinal) => {
    void isLadderIndex;
    const half = Math.max(8, Math.round((strip.x1 - strip.x0) / 2));
    const controlPoints: { x: number; y: number }[] = [];
    let totalInt = 0;
    let intCount = 0;
    for (const y of yRows) {
      let sx = 0;
      let sw = 0;
      const win = half + 14;
      for (let xx = Math.round(strip.cx - win); xx <= strip.cx + win; xx++) {
        const v = grayAt(img, xx, y);
        if (v > threshold) {
          sx += v * xx;
          sw += v;
        }
      }
      const cx = sw > 0 ? sx / sw : strip.cx;
      controlPoints.push({ x: cx, y });
      for (let xx = Math.round(cx - half); xx <= cx + half; xx++) {
        totalInt += grayAt(img, xx, y);
        intCount++;
      }
    }
    const poly = catmullRom(controlPoints, 16);
    const table = arcLengthTable(poly);
    const totalLength = table[table.length - 1];
    return {
      ordinal,
      controlPoints,
      halfWidthPx: half,
      poly,
      table,
      totalLength,
      frontTopT: 0,
      meanIntensity: intCount ? totalInt / intCount : 0,
      boundaryXs: [strip.x0, strip.x1],
      sampledRows: sampleRows.length,
    };
  });
}
