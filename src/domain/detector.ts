/** 自动候选检测：泳道边界与条带中心，全部保留像素级来源。
 *  输出是"候选"，人工修订走独立事件，不覆盖。 */
import { colProfile, rowProfile, sample, type GrayImage } from "./image";
import type { BandCenter, BandFlag, LaneBoundary, PixelPoint, Result } from "./types";
import { ok, fail, DEFAULT_BUDGET, type Budget, type Diagnostic } from "./types";

export interface DetectParams {
  expectedLanes: number;
  laneCountHint?: number;
  minBandContrast: number;   // 峰相对局部基线的最小对比度
  saturationLevel: number;   // 饱和阈值（count）
  version: string;           // 参数版本
}

export const DETECTOR_V1: DetectParams = {
  expectedLanes: 8,
  minBandContrast: 18,
  saturationLevel: 250,
  version: "detector-v1",
};

function findRuns(profile: number[], threshold: number): [number, number][] {
  const runs: [number, number][] = [];
  let start = -1;
  for (let i = 0; i < profile.length; i++) {
    if (profile[i] >= threshold && start < 0) start = i;
    if ((profile[i] < threshold || i === profile.length - 1) && start >= 0) {
      runs.push([start, profile[i] < threshold ? i - 1 : i]);
      start = -1;
    }
  }
  return runs;
}

/** 泳道检测：列投影找亮区，弯曲泳道用逐行质心跟踪 */
export function detectLanes(img: GrayImage, params: DetectParams, budget: Budget = DEFAULT_BUDGET): Result<LaneBoundary[]> {
  const diagnostics: Diagnostic[] = [];
  if (img.width * img.height > budget.maxImagePixels) {
    return fail("budget-exhausted", [{
      code: "BUDGET_IMAGE_PIXELS",
      message: `图像 ${img.width}x${img.height} 超出像素预算 ${budget.maxImagePixels}`,
      severity: "error",
    }]);
  }
  if (params.expectedLanes > budget.maxLanes) {
    return fail("budget-exhausted", [{
      code: "BUDGET_LANES",
      message: `泳道数 ${params.expectedLanes} 超出预算 ${budget.maxLanes}`,
      severity: "error",
    }]);
  }
  const col = colProfile(img, 0, img.height - 1);
  const max = Math.max(...col);
  if (max <= 0) {
    return fail("semantic-unsolvable", [{
      code: "NO_SIGNAL",
      message: "列投影无信号，无法定位泳道",
      severity: "error",
    }]);
  }
  const runs = findRuns(col, max * 0.08).filter(([a, b]) => b - a >= 3);
  if (runs.length === 0) {
    return fail("semantic-unsolvable", [{
      code: "NO_LANES",
      message: "未找到泳道区域",
      severity: "error",
    }]);
  }
  const lanes: LaneBoundary[] = [];
  const picked = runs.slice(0, budget.maxLanes);
  picked.forEach(([x0, x1], laneIndex) => {
    // 逐行质心跟踪，得到泳道中心曲线（弯曲泳道）
    const centerPts: PixelPoint[] = [];
    const leftPts: PixelPoint[] = [];
    const rightPts: PixelPoint[] = [];
    const step = Math.max(1, Math.floor(img.height / 200));
    for (let y = 0; y < img.height; y += step) {
      let s = 0, sx = 0;
      for (let x = x0; x <= x1; x++) {
        const v = img.data[y * img.width + x];
        s += v; sx += v * x;
      }
      const cx = s > 0 ? sx / s : (x0 + x1) / 2;
      centerPts.push({ x: cx, y });
      leftPts.push({ x: cx - (x1 - x0) / 2, y });
      rightPts.push({ x: cx + (x1 - x0) / 2, y });
    }
    lanes.push({
      laneIndex,
      left: leftPts,
      right: rightPts,
      center: { points: centerPts, basis: "image-derotated" },
      basis: "image-derotated",
    });
  });
  if (picked.length < params.expectedLanes) {
    diagnostics.push({
      code: "LANE_COUNT_MISMATCH",
      message: `期望 ${params.expectedLanes} 条泳道，检测到 ${picked.length} 条`,
      location: "lanes",
      severity: "warning",
    });
  }
  return ok(lanes, diagnostics);
}

export interface DetectedBand extends BandCenter {}

/** 沿泳道中心曲线采样一维剖面并找峰 */
export function detectBands(
  img: GrayImage,
  lane: LaneBoundary,
  params: DetectParams,
  budget: Budget = DEFAULT_BUDGET,
): Result<DetectedBand[]> {
  const diagnostics: Diagnostic[] = [];
  const pts = lane.center.points;
  if (pts.length < 2) {
    return fail("semantic-unsolvable", [{
      code: "LANE_TOO_SHORT",
      message: `泳道 ${lane.laneIndex} 中心曲线过短`,
      location: `lane:${lane.laneIndex}`,
      severity: "error",
    }]);
  }
  // 沿曲线弧长采样
  const samples: { s: number; v: number; x: number; y: number }[] = [];
  let s = 0;
  for (let i = 0; i < pts.length; i++) {
    if (i > 0) s += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y);
    samples.push({ s, v: sample(img, pts[i].x, pts[i].y), x: pts[i].x, y: pts[i].y });
  }
  const n = samples.length;
  const win = Math.max(3, Math.floor(n / 60));
  const bands: DetectedBand[] = [];
  for (let i = win; i < n - win; i++) {
    if (bands.length >= budget.maxBandsPerLane) {
      return fail("budget-exhausted", [{
        code: "BUDGET_BANDS",
        message: `泳道 ${lane.laneIndex} 条带数超出预算 ${budget.maxBandsPerLane}`,
        location: `lane:${lane.laneIndex}`,
        severity: "error",
      }]);
    }
    const v = samples[i].v;
    let base = 0;
    for (let k = -win; k <= win; k += win) base += samples[i + k].v;
    base /= 3;
    if (v - base < params.minBandContrast) continue;
    if (v < samples[i - 1].v || v <= samples[i + 1].v) continue;
    // 子像素质心
    let ws = 0, wv = 0;
    for (let k = -win; k <= win; k++) {
      const w = Math.max(0, samples[i + k].v - base);
      ws += w * samples[i + k].s;
      wv += w;
    }
    const centroidS = wv > 0 ? ws / wv : samples[i].s;
    // 半高宽
    const half = base + (v - base) / 2;
    let lo = i, hi = i;
    while (lo > 0 && samples[lo].v > half) lo--;
    while (hi < n - 1 && samples[hi].v > half) hi++;
    const halfWidthPx = (samples[hi].s - samples[lo].s) / 2;
    // 由弧长反查像素坐标
    let cx = samples[i].x, cy = samples[i].y;
    for (let k = 1; k < n; k++) {
      if (samples[k].s >= centroidS) {
        const t = (centroidS - samples[k - 1].s) / Math.max(1e-9, samples[k].s - samples[k - 1].s);
        cx = samples[k - 1].x + t * (samples[k].x - samples[k - 1].x);
        cy = samples[k - 1].y + t * (samples[k].y - samples[k - 1].y);
        break;
      }
    }
    const flags: BandFlag[] = [];
    if (v >= params.saturationLevel) flags.push("saturated");
    // 拖尾：右肩明显比左肩宽
    const leftW = samples[i].s - samples[lo].s, rightW = samples[hi].s - samples[i].s;
    if (rightW > 2.5 * Math.max(1, leftW)) flags.push("smearing");
    // 重叠：半高宽显著大于泳道典型宽度
    if (halfWidthPx > img.height / 40) flags.push("overlap");
    if (flags.length === 0) flags.push("ok");
    bands.push({
      laneIndex: lane.laneIndex,
      center: { x: cx, y: cy },
      halfWidthPx,
      peakIntensity: { value: Math.round(v), unit: "count" },
      flags,
      status: "auto-candidate",
      basis: "image-derotated",
    });
    i += Math.floor(win / 2); // 跳过峰的肩部
  }
  // 重叠后处理：相邻峰距小于两者半高宽之和则都标 overlap
  for (let i = 1; i < bands.length; i++) {
    const gap = Math.abs(bands[i].center.y - bands[i - 1].center.y);
    if (gap < bands[i].halfWidthPx + bands[i - 1].halfWidthPx) {
      for (const b of [bands[i], bands[i - 1]]) {
        if (!b.flags.includes("overlap")) b.flags = [...b.flags.filter((f) => f !== "ok"), "overlap"];
      }
    }
  }
  return ok(bands, diagnostics);
}
