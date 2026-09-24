// 自动候选：检测条带中心、轮廓、饱和平台、拖尾、重叠。只产生候选，不静默修改来源。
import type { BandIssue, GelParams, RasterContent, Vec2 } from "./types";
import type { Profile } from "./profile";
import { extractProfile, percentile } from "./profile";
import { buildCurve, interpAt, projectPoint } from "./curveMath";

export interface DetectedBand {
  s: number;
  center: Vec2;
  contour: Vec2[];
  peakIntensity: number;
  widthS: number;
  issues: BandIssue[];
}

export interface DetectionResult {
  bands: DetectedBand[];
  noiseLevel: number;
  opsUsed: number;
}

export function detectBands(
  raster: RasterContent,
  center: Vec2[],
  halfWidth: number,
  params: GelParams
): DetectionResult {
  let ops = 0;
  const profile: Profile = extractProfile(raster, center, halfWidth);
  ops += profile.s.length * (2 * halfWidth + 1);
  if (ops > params.budget.maxOps) {
    return { bands: [], noiseLevel: 0, opsUsed: ops };
  }
  const noise = percentile(profile.intensity, params.bandDetection.noisePercentile);
  const peaks = findPeaks(profile, noise, params);
  ops += peaks.length * 40;
  const curve = buildCurve(center);

  const detected: DetectedBand[] = peaks.map((peak) => {
    const c = interpAt(curve, peak.s);
    const widthS = peak.widthS;
    const issues = classify(raster, profile, peak, params, widthS);
    const contour = extractContour(raster, c, widthS, halfWidth, params);
    return { s: peak.s, center: c, contour, peakIntensity: peak.height, widthS, issues };
  });

  // 重叠标记：同 lane 两个峰距离低于合并阈值
  const minD = params.overlap.mergeSdRatio;
  for (let i = 0; i < detected.length; i++) {
    for (let j = i + 1; j < detected.length; j++) {
      const gap = Math.abs(detected[i].s - detected[j].s);
      const ref = 2 * Math.max(detected[i].widthS, detected[j].widthS);
      if (gap < minD * ref) {
        if (!detected[i].issues.includes("overlap")) detected[i].issues.push("overlap");
        if (!detected[j].issues.includes("overlap")) detected[j].issues.push("overlap");
      }
    }
  }

  detected.sort((a, b) => a.s - b.s);
  return { bands: detected, noiseLevel: noise, opsUsed: ops };
}

interface Peak {
  s: number;
  height: number;
  widthS: number;
  plateau: number;
  rightSlope: number;
}

function findPeaks(profile: Profile, noise: number, params: GelParams): Peak[] {
  const { s, intensity } = profile;
  const prom = params.bandDetection.minProminence;
  const peaks: Peak[] = [];
  let i = 1;
  while (i < intensity.length - 1) {
    if (intensity[i] > noise + prom && intensity[i] >= intensity[i - 1] && intensity[i] >= intensity[i + 1]) {
      let j = i;
      while (j + 1 < intensity.length && intensity[j + 1] >= intensity[i] - 0.5) j++;
      const leftHalf = halfWidthAt(s, intensity, i, noise, -1);
      const rightHalf = halfWidthAt(s, intensity, i, noise, 1);
      const plateau = j - i;
      const rightSlope = trailingSlope(profile, i, params);
      peaks.push({
        s: s[i],
        height: intensity[i],
        widthS: Math.max(1, (leftHalf + rightHalf) / 2),
        plateau,
        rightSlope
      });
      i = Math.max(i + 1, j + 2);
    } else i++;
  }
  const merged: Peak[] = [];
  for (const p of peaks) {
    if (merged.length && p.s - merged[merged.length - 1].s < params.bandDetection.minBandSpacingPx) {
      merged[merged.length - 1].height = Math.max(merged[merged.length - 1].height, p.height);
    } else merged.push(p);
  }
  return merged;
}

function halfWidthAt(s: number[], v: number[], i: number, noise: number, dir: -1 | 1): number {
  const half = noise + (v[i] - noise) / 2;
  let j = i;
  while (j + dir >= 0 && j + dir < v.length && v[j + dir] > half) j += dir;
  return Math.abs(s[j] - s[i]);
}

function trailingSlope(profile: Profile, i: number, params: GelParams): number {
  const v = profile.intensity;
  const win = Math.max(3, Math.round(6));
  const j = Math.min(v.length - 1, i + win);
  const ds = profile.s[j] - profile.s[i] || 1;
  return (v[j] - v[i]) / ds;
}

function classify(
  raster: RasterContent,
  _profile: Profile,
  peak: Peak,
  params: GelParams,
  _widthS: number
): BandIssue[] {
  const issues: BandIssue[] = [];
  const plateauFrac = peak.plateau / Math.max(1, Math.round(peak.widthS * 2));
  if (peak.height >= 254 || plateauFrac >= params.saturation.plateauRatio) issues.push("saturated");
  // 拖尾：迁移正方向衰减明显慢于高斯（斜率绝对值小），且非饱和平台
  if (-peak.rightSlope < params.saturation.tailSlope && peak.height < 250) issues.push("tailing");
  void raster;
  return issues;
}

function extractContour(
  raster: RasterContent,
  center: Vec2,
  widthS: number,
  halfWidth: number,
  params: GelParams
): Vec2[] {
  const threshold = 255 * 0; // replaced below
  void threshold;
  // 以背景噪声估计不可得，这里用中心像素亮度与剖面阈值：从剖面外部注入阈值更精确，
  // 因此采用局部最暗环带作为基准（保守轮廓）。
  const base = sampleBilinear(raster, center.x, center.y);
  const level = base - (base - localBackground(raster, center, halfWidth)) * params.bandDetection.contourThresholdRatio;
  const contour: Vec2[] = [];
  const RAYS = 28;
  const maxR = Math.max(halfWidth * 1.4, widthS * 2.2);
  for (let r = 0; r < RAYS; r++) {
    const ang = (2 * Math.PI * r) / RAYS;
    const dx = Math.cos(ang);
    const dy = Math.sin(ang);
    let hit: Vec2 | null = null;
    for (let step = 1; step <= Math.ceil(maxR); step++) {
      const x = center.x + dx * step;
      const y = center.y + dy * step;
      const val = sampleBilinear(raster, x, y);
      if (val <= level) {
        hit = { x, y };
        break;
      }
    }
    contour.push(hit ?? { x: center.x + dx * maxR, y: center.y + dy * maxR });
  }
  return contour;
}

function localBackground(raster: RasterContent, center: Vec2, halfWidth: number): number {
  const offsets = [
    { x: 0, y: -halfWidth * 2.4 },
    { x: 0, y: halfWidth * 2.4 }
  ];
  let sum = 0;
  let n = 0;
  for (const o of offsets) {
    const v = sampleBilinear(raster, center.x + o.x, center.y + o.y);
    if (v >= 0) {
      sum += v;
      n++;
    }
  }
  return n ? sum / n : 0;
}

export function sampleBilinear(raster: RasterContent, x: number, y: number): number {
  if (x < 0 || y < 0 || x > raster.width - 1 || y > raster.height - 1) return -1;
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const x1 = Math.min(raster.width - 1, x0 + 1);
  const y1 = Math.min(raster.height - 1, y0 + 1);
  const fx = x - x0;
  const fy = y - y0;
  const a = raster.grayscale[y0 * raster.width + x0];
  const b = raster.grayscale[y0 * raster.width + x1];
  const c = raster.grayscale[y1 * raster.width + x0];
  const d = raster.grayscale[y1 * raster.width + x1];
  return a * (1 - fx) * (1 - fy) + b * fx * (1 - fy) + c * (1 - fx) * fy + d * fx * fy;
}

export { projectPoint };
