import type { BandFlag, GrayImage as _G, Point } from './types.js';
import { at, profile, smooth } from './image.js';
import type { GrayImage } from './image.js';
import { fitQuadraticCenterline, boundariesFromCenter } from './geometry.js';

/**
 * 自动候选检测（结果一律是“候选”，不能自动接受）：
 * 1) 用行列投影判定拍摄方向（条带沿泳道方向延展 → 正确方向下泳道列投影峰更尖锐）
 * 2) 列投影找泳道中心线，逐行追踪弯曲
 * 3) 泳道内行投影找带；峰值>=250 判饱和；双峰谷浅判重叠；下行肩峰判拖尾
 */

export interface DetectedLane {
  laneIndex: number;
  centerline: Point[];
  leftBoundary: Point[];
  rightBoundary: Point[];
  curvature: 'straight' | 'smile' | 'frown' | 'custom';
}

export interface DetectedBand {
  laneIndex: number;
  center: Point;
  contour: Point[];
  saturatedPixels: Point[];
  flags: BandFlag[];
}

export function orientationScore(img: GrayImage): {
  bestDeg: 0 | 90;
  score0: number;
  score90: number;
} {
  const cols = smooth(profile(img, 'columns'), 5);
  const rows = smooth(profile(img, 'rows'), 5);
  const score0 = peakiness(cols); // 竖向泳道：列投影应出现强泳道峰
  const score90 = peakiness(rows);
  return { bestDeg: score0 >= score90 ? 0 : 90, score0, score90 };
}

function peakiness(values: number[]): number {
  const max = Math.max(...values);
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return max / (mean || 1);
}

export function detectLanes(
  img: GrayImage,
  opts: { minPeakRatio?: number; halfWidth?: number } = {},
): DetectedLane[] {
  const cols = smooth(profile(img, 'columns'), 7);
  const threshold = Math.max(...cols) * (opts.minPeakRatio ?? 0.45);
  const peaks: number[] = [];
  for (let x = 2; x < cols.length - 2; x++) {
    if (cols[x]! > threshold && cols[x]! >= cols[x - 1]! && cols[x]! >= cols[x + 1]!) {
      if (!peaks.length || x - peaks[peaks.length - 1]! > 24) peaks.push(x);
      else if (cols[x]! > cols[peaks[peaks.length - 1]!]!) peaks[peaks.length - 1] = x;
    }
  }
  const halfWidth = opts.halfWidth ?? 16;
  return peaks.map((x0, laneIndex) => {
    // 逐行追踪亮脊：在 ±halfWidth 窗口取最亮列
    const ys: number[] = [];
    const xs: number[] = [];
    for (let y = 6; y < img.height - 6; y += 6) {
      let bx = x0;
      let bv = -1;
      for (let x = x0 - halfWidth; x <= x0 + halfWidth; x++) {
        const v = at(img, x, y);
        if (v > bv) { bv = v; x && (bx = x); }
      }
      ys.push(y);
      xs.push(bx);
    }
    const fit = fitQuadraticCenterline(ys, xs);
    const centerline: Point[] = [];
    for (let y = 8; y < img.height - 8; y += 10) centerline.push(fit.sample(y));
    const { left, right } = boundariesFromCenter(centerline, halfWidth);
    const curvature: DetectedLane['curvature'] =
      fit.c < -0.0004 ? 'smile' : fit.c > 0.0004 ? 'frown' : 'straight';
    return { laneIndex, centerline, leftBoundary: left, rightBoundary: right, curvature };
  });
}

export function detectBands(
  img: GrayImage,
  lanes: DetectedLane[],
  opts: { saturation?: number; valleyRatio?: number } = {},
): DetectedBand[] {
  const satThreshold = opts.saturation ?? 250;
  const valleyRatio = opts.valleyRatio ?? 0.82;
  const out: DetectedBand[] = [];

  lanes.forEach((lane) => {
    // 泳道内逐行亮度
    const rows: number[] = [];
    for (let y = 0; y < img.height; y++) {
      let s = 0;
      const xMid = lane.centerline[Math.min(lane.centerline.length - 1, Math.floor(y / 10))]?.x ?? 0;
      for (let x = Math.round(xMid) - 12; x <= Math.round(xMid) + 12; x++) s += at(img, x, y);
      rows.push(s);
    }
    const sm = smooth(rows, 3);
    const thr = Math.max(...sm) * 0.2;
    const peaks: number[] = [];
    for (let y = 4; y < sm.length - 4; y++) {
      if (sm[y]! > thr && sm[y]! >= sm[y - 1]! && sm[y]! >= sm[y + 1]!) peaks.push(y);
    }
    // 合并过近峰
    const merged: number[] = [];
    for (const y of peaks) {
      if (merged.length && y - merged[merged.length - 1]! < 7) {
        if (sm[y]! > sm[merged[merged.length - 1]!]!) merged[merged.length - 1] = y;
      } else merged.push(y);
    }

    merged.forEach((y, idx) => {
      const cx = Math.round(lane.centerline[Math.min(lane.centerline.length - 1, Math.floor(y / 10))]!.x);
      const center = { x: cx, y };
      const flags: BandFlag[] = [];
      const saturatedPixels: Point[] = [];
      for (let yy = y - 6; yy <= y + 6; yy++)
        for (let xx = cx - 14; xx <= cx + 14; xx++)
          if (at(img, xx, yy) >= satThreshold) saturatedPixels.push({ x: xx, y: yy });
      if (saturatedPixels.length > 20) flags.push('saturated');

      // 重叠：与下一个峰距离很近且峰谷较浅
      const next = merged[idx + 1];
      if (next !== undefined && next - y <= 13) {
        const valley = sm[Math.round((y + next) / 2)]!;
        if (valley / Math.min(sm[y]!, sm[next]!) > valleyRatio) {
          flags.push('overlap');
        }
      }
      // 拖尾：峰下方（迁移方向）残留亮肩
      let tailSum = 0;
      for (let k = 4; k <= 12; k++) tailSum += sm[y + k] ?? 0;
      let headSum = 0;
      for (let k = 4; k <= 12; k++) headSum += sm[y - k] ?? 0;
      if (!flags.includes('overlap') && tailSum > headSum * 1.35 && tailSum > thr * 5) {
        flags.push('tailed');
      }

      const contour: Point[] = [];
      for (let i = 0; i < 24; i++) {
        const t = (i / 24) * Math.PI * 2;
        contour.push({ x: cx + 13 * Math.cos(t), y: y + 4.5 * Math.sin(t) });
      }
      out.push({ laneIndex: lane.laneIndex, center, contour, saturatedPixels, flags });
    });
  });
  return out;
}

export function runAutoDetection(img: GrayImage) {
  const orient = orientationScore(img);
  const lanes = detectLanes(img);
  const bands = detectBands(img, lanes);
  return { orient, lanes, bands };
}
