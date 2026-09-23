import type {
  BandFlag,
  BudgetReport,
  DetectedBand,
  DetectedLane,
  LaneProfile,
  PixelPoint,
} from '@shared/types.js';
import type { Image8 } from './image.js';
import { clamp } from '@shared/util.js';

export interface DetectionOptions {
  pixelBudget: number;
  laneThresholdOffset: number; // 高于背景多少认为是泳道
  bandProminence: number; // 条带相对 lane 背景的最小显著度
  minBandSpacing: number;
  minBandWidth: number;
  maxBandWidth: number;
  bandHalfWidthX: number; // 沿中心横向平均宽度
  saturationGray: number;
  overlapWidthFactor: number; // 峰宽超过中位宽度的倍数判为重叠/过宽
  trailingSkew: number; // 左右半峰宽不对称比例
}

export const DEFAULT_DETECTION: DetectionOptions = {
  pixelBudget: 24_000_000,
  laneThresholdOffset: 5,
  bandProminence: 22,
  minBandSpacing: 6,
  minBandWidth: 3,
  maxBandWidth: 60,
  bandHalfWidthX: 4,
  saturationGray: 250,
  overlapWidthFactor: 1.45,
  trailingSkew: 1.45,
};

export interface DetectorBudget {
  pixelsUsed: number;
  pixelBudget: number;
}

function makeBudget(opts: DetectionOptions): DetectorBudget {
  return { pixelsUsed: 0, pixelBudget: opts.pixelBudget };
}

function charge(b: DetectorBudget, n: number, subjectIds: string[]): void {
  b.pixelsUsed += n;
  if (b.pixelsUsed > b.pixelBudget) {
    const err = new Error('budget-exhausted');
    (err as any).code = 'budget-exhausted';
    (err as any).subjectIds = subjectIds;
    (err as any).budget = {
      pixelBudget: b.pixelBudget,
      pixelsUsed: b.pixelsUsed,
      exhausted: true,
    } satisfies BudgetReport;
    throw err;
  }
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

/** 全局背景灰度。 */
export function backgroundLevel(img: Image8): number {
  const step = Math.max(1, Math.floor(Math.sqrt((img.width * img.height) / 4000)));
  const vals: number[] = [];
  for (let y = 0; y < img.height; y += step) {
    for (let x = 0; x < img.width; x += step) {
      vals.push(img.gray[y * img.width + x]);
    }
  }
  // 背景取低分位，避免条带抬高
  vals.sort((a, b) => a - b);
  return vals[Math.floor(vals.length * 0.2)];
}

/**
 * 泳道检测：列投影找种子区间，再逐行用局部窗口跟踪弯曲中心与边缘。
 * 返回 canonical 像素折线。
 */
export function detectLanes(
  img: Image8,
  expectedCount: number,
  laneHalfWidthHint: number,
  opts: DetectionOptions,
  budget: DetectorBudget = makeBudget(opts),
): { lanes: DetectedLane[]; budget: BudgetReport } {
  charge(budget, img.width * img.height, ['image']);
  const bg = backgroundLevel(img);
  const threshold = bg + opts.laneThresholdOffset;

  const col: number[] = new Array(img.width).fill(0);
  for (let x = 0; x < img.width; x++) {
    let sum = 0;
    for (let y = 0; y < img.height; y++) sum += img.gray[y * img.width + x];
    col[x] = sum / img.height;
  }

  const active = col.map((v) => v > threshold);
  const segments: { lo: number; hi: number }[] = [];
  let i = 0;
  while (i < img.width) {
    if (active[i]) {
      let j = i;
      while (j < img.width && active[j]) j++;
      segments.push({ lo: i, hi: j - 1 });
      i = j;
    } else i++;
  }

  // 合并过近区间并按宽度选与期望数量最接近者
  let ranges = segments.filter((s) => s.hi - s.lo >= Math.max(4, laneHalfWidthHint));
  if (ranges.length > expectedCount) {
    ranges = ranges
      .map((s) => ({ ...s, w: s.hi - s.lo }))
      .sort((a, b) => b.w - a.w)
      .slice(0, expectedCount)
      .sort((a, b) => a.lo - b.lo)
      .map(({ lo, hi }) => ({ lo, hi }));
  }

  const win = Math.max(3, laneHalfWidthHint + 2);
  const lanes: DetectedLane[] = ranges.map((range, idx) => {
    const centerline: PixelPoint[] = [];
    const leftEdge: PixelPoint[] = [];
    const rightEdge: PixelPoint[] = [];
    const seedX = (range.lo + range.hi) / 2;
    let prevX = seedX;
    for (let y = 0; y < img.height; y++) {
      let bestX = prevX;
      let bestScore = -Infinity;
      for (let x = Math.max(0, Math.floor(prevX - win)); x <= Math.min(img.width - 1, Math.ceil(prevX + win)); x++) {
        let score = 0;
        for (let dx = -laneHalfWidthHint; dx <= laneHalfWidthHint; dx++) {
          const xx = x + dx;
          if (xx >= 0 && xx < img.width) score += img.gray[y * img.width + xx];
        }
        // 轻微连续性约束
        score -= Math.abs(x - prevX) * 4;
        if (score > bestScore) {
          bestScore = score;
          bestX = x;
        }
      }
      prevX = bestX;
      // 局部边缘：阈值穿越
      let le = Math.round(bestX) - laneHalfWidthHint;
      let re = Math.round(bestX) + laneHalfWidthHint;
      for (let x = Math.round(bestX); x >= Math.max(0, Math.round(bestX) - win - laneHalfWidthHint); x--) {
        if (img.gray[y * img.width + x] <= threshold) {
          le = x;
          break;
        }
      }
      for (let x = Math.round(bestX); x <= Math.min(img.width - 1, Math.round(bestX) + win + laneHalfWidthHint); x++) {
        if (img.gray[y * img.width + x] <= threshold) {
          re = x;
          break;
        }
      }
      centerline.push({ x: bestX, y });
      leftEdge.push({ x: le, y });
      rightEdge.push({ x: re, y });
    }
    const laneId = `lane-${idx + 1}`;
    return { laneId, centerline, leftEdge, rightEdge, confidence: 0.9 };
  });

  return {
    lanes,
    budget: {
      pixelBudget: budget.pixelBudget,
      pixelsUsed: budget.pixelsUsed,
      exhausted: budget.pixelsUsed > budget.pixelBudget,
    },
  };
}

interface Peak {
  t: number;
  x: number;
  left: number;
  right: number;
  max: number;
  plateau: number; // 饱和平台长度
  leftHalfWidth: number;
  rightHalfWidth: number;
}

/** 沿单泳道中心线采样轮廓。 */
export function profileForLane(
  img: Image8,
  centerline: PixelPoint[],
  halfWidthX: number,
  budget: DetectorBudget,
  laneId: string,
): LaneProfile {
  const points = [];
  for (let y = 0; y < img.height; y++) {
    const p = centerline[y] ?? centerline[centerline.length - 1];
    let sum = 0;
    let n = 0;
    for (let dx = -halfWidthX; dx <= halfWidthX; dx++) {
      const x = Math.round(p.x) + dx;
      if (x >= 0 && x < img.width) {
        sum += img.gray[y * img.width + x];
        n++;
      }
    }
    charge(budget, Math.max(1, n), [laneId]);
    points.push({ t: y, x: p.x, y, intensity: sum / Math.max(1, n) });
  }
  return { laneId, points };
}

function findPeaks(profile: { t: number; x: number; intensity: number }[], bg: number, opts: DetectionOptions): Peak[] {
  const peaks: Peak[] = [];
  const threshold = bg + opts.bandProminence;
  let i = 1;
  while (i < profile.length - 1) {
    if (profile[i].intensity >= threshold && profile[i].intensity >= profile[i - 1].intensity) {
      let j = i;
      let max = profile[i].intensity;
      let maxT = i;
      while (j < profile.length - 1 && profile[j + 1].intensity >= threshold) {
        j++;
        if (profile[j].intensity > max) {
          max = profile[j].intensity;
          maxT = j;
        }
      }
      const left = i;
      const right = j;
      // 半峰宽
      const half = bg + (max - bg) / 2;
      let l = maxT;
      while (l > left && profile[l - 1].intensity >= half) l--;
      let r = maxT;
      while (r < right && profile[r + 1].intensity >= half) r++;
      // 饱和平台
      let plateau = 0;
      for (let k = left; k <= right; k++) {
        if (profile[k].intensity >= opts.saturationGray) plateau++;
      }
      // 非极大抑制范围内合并由宽度判定处理
      peaks.push({
        t: profile[maxT].t,
        x: profile[maxT].x,
        left: profile[left].t,
        right: profile[right].t,
        max,
        plateau,
        leftHalfWidth: Math.max(1, maxT - l),
        rightHalfWidth: Math.max(1, r - maxT),
      });
      i = j + 1;
    } else i++;
  }
  return peaks;
}

function splitOverlap(peak: Peak, img: Image8, x: number): PixelPoint[] {
  // 在过宽峰内寻找双峰：对轮廓做二阶局部极小，返回候选中心
  const candidates: PixelPoint[] = [];
  const row = (t: number) => img.gray[clamp(Math.round(t), 0, img.height - 1) * img.width + clamp(Math.round(x), 0, img.width - 1)];
  const half = peak.left + (peak.right - peak.left) / 2;
  let mid = Math.round(half);
  let bestVal = Infinity;
  for (let t = peak.left + 2; t <= peak.right - 2; t++) {
    const v = row(t);
    if (v < bestVal && t > peak.left && t < peak.right) {
      bestVal = v;
      mid = t;
    }
  }
  if (mid > peak.left + 2 && mid < peak.right - 2) {
    candidates.push({ x, y: peak.left + (mid - peak.left) / 2 });
    candidates.push({ x, y: mid + (peak.right - mid) / 2 });
  } else {
    candidates.push({ x, y: peak.t - (peak.right - peak.left) / 4 });
    candidates.push({ x, y: peak.t + (peak.right - peak.left) / 4 });
  }
  return candidates;
}

export interface BandDetectionOutput {
  bands: DetectedBand[];
  profiles: LaneProfile[];
  budget: BudgetReport;
}

export function detectBands(
  img: Image8,
  lanes: { laneId: string; centerline: PixelPoint[] }[],
  opts: DetectionOptions,
  budget: DetectorBudget = makeBudget(opts),
): BandDetectionOutput {
  const bg = backgroundLevel(img);
  const bands: DetectedBand[] = [];
  const profiles: LaneProfile[] = [];

  for (const lane of lanes) {
    const profile = profileForLane(img, lane.centerline, opts.bandHalfWidthX, budget, lane.laneId);
    profiles.push(profile);
    const peaks = findPeaks(profile.points, bg, opts);
    const widths = peaks.map((p) => p.right - p.left).filter((w) => w >= opts.minBandWidth);
    const medWidth = median(widths.length ? widths : [opts.minBandWidth * 2]);

    for (const peak of peaks) {
      const widthPx = peak.right - peak.left;
      if (widthPx < opts.minBandWidth || widthPx > opts.maxBandWidth * 2) continue;
      const flags: BandFlag[] = [];
      const saturated = peak.plateau >= 2;
      const trailing =
        peak.rightHalfWidth > peak.leftHalfWidth * opts.trailingSkew ||
        peak.leftHalfWidth > peak.rightHalfWidth * opts.trailingSkew;
      const overlap = widthPx > medWidth * opts.overlapWidthFactor && widthPx >= opts.minBandSpacing * 2;
      if (saturated) flags.push('saturated');
      if (trailing) flags.push('trailing');
      if (overlap) flags.push('overlap', 'broad');
      else if (widthPx > medWidth * 1.2) flags.push('broad');

      const center: PixelPoint = { x: peak.x, y: peak.t };
      let alternatives: PixelPoint[] = [];
      if (overlap) {
        alternatives = splitOverlap(peak, img, peak.x);
      }
      bands.push({
        bandObservationId: '', // 由上层根据 case/材料身份分配
        laneId: lane.laneId,
        center,
        t: peak.t,
        peakIntensity: Math.round(peak.max * 10) / 10,
        widthPx: Math.round(widthPx * 10) / 10,
        flags,
        alternatives,
      });
    }
  }
  return {
    bands,
    profiles,
    budget: {
      pixelBudget: budget.pixelBudget,
      pixelsUsed: budget.pixelsUsed,
      exhausted: budget.pixelsUsed > budget.pixelBudget,
    },
  };
}
