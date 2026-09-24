import type { Diagnostic, WorkbenchParams, XY } from "./types.js";
import type { Raster } from "./png.js";
import { profileAlong } from "./geometry.js";

export interface DetectedLane {
  ordinal: number;
  baseX: number;
  halfWidth: number;
  curve: XY[];
  coverage: number;
}

export interface LaneDetectionOutcome {
  lanes: DetectedLane[];
  orientationOk: boolean;
  diagnostics: Diagnostic[];
}

function smooth(values: number[], window: number): number[] {
  const half = Math.floor(window / 2);
  return values.map((_, i) => {
    let sum = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(values.length - 1, i + half); j++) {
      sum += values[j];
      n++;
    }
    return sum / n;
  });
}

function percentile(values: number[], q: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))];
}

/**
 * 泳道检测：列投影找亮带竖列，再逐行在列附近做亮度质心，恢复弯曲（含“微笑”）。
 * 旋转 90° 时列投影无结构 → orientation_mismatch 诊断，且不伪装成功。
 */
export function detectLanes(
  raster: Raster,
  _params: WorkbenchParams
): LaneDetectionOutcome {
  const { width, height, pixels } = raster;
  const colProj = new Float64Array(width);
  const rowProj = new Float64Array(height);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = pixels[y * width + x];
      colProj[x] += v;
      rowProj[y] += v;
    }
  }
  for (let x = 0; x < width; x++) colProj[x] /= height;
  for (let y = 0; y < height; y++) rowProj[y] /= width;
  const colVar = variance(Array.from(colProj));
  const rowVar = variance(Array.from(rowProj));
  const diagnostics: Diagnostic[] = [];
  if (colVar < rowVar * 1.5) {
    diagnostics.push({
      code: "orientation_mismatch",
      severity: "error",
      message:
        "行向亮度变化不低于列向：图像可能旋转了 90°，泳道方向与坐标基准不一致，已拒绝检测",
      location: { pixel: { x: 0, y: 0, frame: "", unit: "pixel" } }
    });
    return { lanes: [], orientationOk: false, diagnostics };
  }
  const bg = percentile(Array.from(colProj), 0.4);
  const sm = smooth(Array.from(colProj), 5);
  const maxV = Math.max(...sm) - bg;
  const threshold = bg + maxV * 0.18;
  const peaks: number[] = [];
  for (let x = 5; x < width - 5; x++) {
    if (sm[x] > threshold && sm[x] >= sm[x - 1] && sm[x] >= sm[x + 1]) {
      if (peaks.length === 0 || x - peaks[peaks.length - 1] > 14) peaks.push(x);
      else if (sm[x] > sm[peaks[peaks.length - 1]]) peaks[peaks.length - 1] = x;
    }
  }
  const halfWidth = 7;
  const imgBg = percentile(Array.from(pixels).slice(0, 4096), 0.3);
  const lanes: DetectedLane[] = peaks.map((baseX, ordinal) => {
    const raw: XY[] = [];
    let covered = 0;
    for (let y = 2; y < height - 2; y += 2) {
      let num = 0;
      let den = 0;
      for (let w = -halfWidth; w <= halfWidth; w++) {
        const xx = baseX + w;
        if (xx < 0 || xx >= width) continue;
        const weight = Math.max(0, pixels[y * width + xx] - imgBg);
        num += xx * weight;
        den += weight;
      }
      if (den > 40) {
        raw.push({ x: num / den, y });
        covered++;
      } else {
        raw.push({ x: baseX, y });
      }
    }
    const curve = smoothXY(raw, 7);
    return {
      ordinal,
      baseX,
      halfWidth,
      curve,
      coverage: covered / (height / 2 - 2)
    };
  });
  return { lanes, orientationOk: true, diagnostics };
}

function smoothXY(points: XY[], window: number): XY[] {
  const half = Math.floor(window / 2);
  return points.map((p, i) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (
      let j = Math.max(0, i - half);
      j <= Math.min(points.length - 1, i + half);
      j++
    ) {
      sx += points[j].x;
      sy += points[j].y;
      n++;
    }
    return { x: sx / n, y: sy / n };
  });
}

function variance(values: number[]): number {
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  return values.reduce((a, b) => a + (b - mean) ** 2, 0) / values.length;
}

export interface ProfilePoint {
  s: number;
  intensity: number;
  fit: number;
  point: XY;
}

export interface DetectedBand {
  ordinalInLane: number;
  s: number;
  sLow: number;
  sHigh: number;
  center: XY;
  sigma: number;
  amplitude: number;
  peakValue: number;
  bandKind:
    | "unique"
    | "saturated"
    | "tailed"
    | "overlap"
    | "missing_ladder";
  saturationRatio: number;
  tailLength: number;
  overlapOrdinal: number | null;
  profile: { s: number; intensity: number; fit: number }[];
}

export interface BandDetectionOutcome {
  bands: DetectedBand[];
  diagnostics: Diagnostic[];
}

/** 条带检测：投影找峰、矩估计拟合高斯、分类饱和/拖尾/重叠；输出轮廓与残差 */
export function detectBands(
  raster: Raster,
  curve: XY[],
  maxSensorValue: number,
  params: WorkbenchParams
): BandDetectionOutcome {
  const diagnostics: Diagnostic[] = [];
  const halfWidth = 7;
  const prof = profileAlong(raster, curve as never, halfWidth, 1);
  const bg = percentile(prof.map((p) => p.intensity), 0.25);
  const corrected = prof.map((p) => ({ ...p, v: p.intensity - bg }));
  const ampByX = corrected.map((c) => c.v);
  const maxAmp = Math.max(...ampByX, 1);
  const minProm = params.bandProminence * maxAmp;

  const peakIdx: number[] = [];
  for (let i = 3; i < corrected.length - 3; i++) {
    const v = corrected[i].v;
    if (v < minProm) continue;
    let isMax = true;
    for (let k = -3; k <= 3; k++) {
      if (k !== 0 && corrected[i + k].v > v) isMax = false;
    }
    if (!isMax) continue;
    if (
      peakIdx.length > 0 &&
      i - peakIdx[peakIdx.length - 1] < 4
    ) {
      if (v > corrected[peakIdx[peakIdx.length - 1]].v) {
        peakIdx[peakIdx.length - 1] = i;
      }
    } else {
      peakIdx.push(i);
    }
  }

  const bands: DetectedBand[] = peakIdx.map((idx) => {
    const win = 7;
    let wsum = 0;
    let ssum = 0;
    let m2 = 0;
    for (let k = -win; k <= win; k++) {
      const j = idx + k;
      if (j < 0 || j >= corrected.length) continue;
      const w = Math.max(0, corrected[j].v);
      wsum += w;
      ssum += w * corrected[j].s;
      m2 += 0;
    }
    const sCenter = wsum > 0 ? ssum / wsum : corrected[idx].s;
    m2 = 0;
    for (let k = -win; k <= win; k++) {
      const j = idx + k;
      if (j < 0 || j >= corrected.length) continue;
      const w = Math.max(0, corrected[j].v);
      m2 += w * (corrected[j].s - sCenter) ** 2;
    }
    let sigma = wsum > 0 ? Math.sqrt(m2 / wsum) : 2;
    sigma = Math.min(12, Math.max(1.4, sigma));
    const amp = corrected[idx].v;

    let peakValue = 0;
    let satCount = 0;
    let sampleCount = 0;
    const cp = corrected[idx].point;
    for (let dy = -3; dy <= 3; dy++) {
      for (let dx = -halfWidth; dx <= halfWidth; dx++) {
        const x = Math.round(cp.x + dx);
        const y = Math.round(cp.y + dy);
        if (x < 0 || y < 0 || x >= raster.width || y >= raster.height) continue;
        const v = raster.pixels[y * raster.width + x];
        peakValue = Math.max(peakValue, v);
        sampleCount++;
        if (v >= maxSensorValue * params.saturationThreshold) satCount++;
      }
    }
    const saturationRatio = sampleCount ? satCount / sampleCount : 0;
    const saturated =
      peakValue >= maxSensorValue * params.saturationThreshold &&
      saturationRatio > 0.08;

    const tailStart = sCenter + 2 * sigma;
    const tailEnd = sCenter + 4.5 * sigma;
    let tailSum = 0;
    let tailN = 0;
    for (const c of corrected) {
      if (c.s >= tailStart && c.s <= tailEnd) {
        tailSum += c.v;
        tailN++;
      }
    }
    const tailMean = tailN ? tailSum / tailN : 0;
    const tailed = tailMean / Math.max(amp, 1) >= params.tailRatio;
    const tailLength = tailed ? Math.max(3, 2.2 * sigma) : 0;

    const profile = corrected.map((c) => ({
      s: c.s,
      intensity: Math.round(c.intensity),
      fit: Math.round(bg + amp * Math.exp(-((c.s - sCenter) ** 2) / (2 * sigma * sigma)))
    }));

    let sLow = sCenter;
    let sHigh = sCenter;
    if (saturated) {
      const halfPlateau = Math.max(sigma, 3);
      sLow = sCenter - halfPlateau * 0.6;
      sHigh = sCenter + halfPlateau * 0.6;
    }

    let kind: DetectedBand["bandKind"] = "unique";
    if (saturated) kind = "saturated";
    else if (tailed) kind = "tailed";

    return {
      ordinalInLane: 0,
      s: sCenter,
      sLow,
      sHigh,
      center: { x: cp.x, y: cp.y },
      sigma,
      amplitude: amp,
      peakValue,
      bandKind: kind,
      saturationRatio,
      tailLength,
      overlapOrdinal: null,
      profile
    };
  });

  // 重叠判定：峰距小于阈值 → 双方只能标为候选/区间
  bands.sort((a, b) => a.s - b.s);
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      if (bands[j].s - bands[i].s <= params.overlapDistancePx) {
        bands[i].bandKind = "overlap";
        bands[j].bandKind = "overlap";
        bands[i].overlapOrdinal = j;
        bands[j].overlapOrdinal = i;
      }
    }
  }
  bands.forEach((b, i) => {
    b.ordinalInLane = i + 1;
    if (b.bandKind === "overlap") {
      const partner = bands.find(
        (x) => x.ordinalInLane === (b.overlapOrdinal ?? -1) + 1
      );
      if (partner) {
        const sep = Math.abs(partner.s - b.s) / 2 + 1;
        b.sLow = b.s - sep;
        b.sHigh = b.s + sep;
      }
    }
    if (b.bandKind === "saturated") {
      diagnostics.push({
        code: "saturated_center",
        severity: "warning",
        message: `s=${b.s.toFixed(1)}px 处条带峰值饱和（${(b.saturationRatio * 100).toFixed(0)}% 像素达上限），只能给候选或区间`,
        location: { pixel: { ...b.center, frame: "", unit: "pixel" } }
      });
    }
  });
  return { bands, diagnostics };
}
