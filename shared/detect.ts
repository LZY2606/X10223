import type { ComputeResult, Diagnostic } from "./types.js";
import { ok, fail } from "./types.js";

/** 资源预算：每次迭代扣减，耗尽即返回 budget-exhausted。 */
export interface Budget {
  remaining: number;
}

export function spend(budget: Budget, n: number): boolean {
  budget.remaining -= n;
  return budget.remaining >= 0;
}

export interface DetectedPeak {
  y: number;
  height: number;
  prominence: number;
  saturated: boolean;
}

export interface BandCluster {
  kind: "single" | "overlap";
  yMin: number;
  yMax: number;
  peaks: DetectedPeak[];
  saturated: boolean;
  smeared: boolean;
}

export interface DetectOpts {
  prominence: number;
  minSeparationPx: number;
  saturationLevel: number;
  smearWindowPx: number;
}

function median(values: number[]): number {
  const s = [...values].sort((a, b) => a - b);
  return s.length % 2 === 0 ? (s[s.length / 2 - 1] + s[s.length / 2]) / 2 : s[(s.length - 1) / 2];
}

/**
 * 从 1D 剖面检测条带。
 * - 饱和（>= saturationLevel）只标记，不伪造精确中心；
 * - 间距小于 2*minSeparationPx 的峰合并为 overlap 簇（只能给区间）；
 * - 拖尾（峰后 smearWindowPx 内信号持续抬高）标记 smeared。
 */
export function detectBands(profile: Float64Array, opts: DetectOpts, budget: Budget): ComputeResult<BandCluster[]> {
  const n = profile.length;
  if (!spend(budget, n)) {
    return fail("budget-exhausted", [
      {
        code: "iteration-budget-exhausted",
        severity: "error",
        message: `剖面扫描超出迭代预算（长度 ${n}）`,
        location: { path: "detectBands.profile", length: n },
      },
    ]);
  }
  const baseline = median(Array.from(profile));
  const threshold = baseline + opts.prominence;

  // 找阈值以上的连续区段
  const runs: { y0: number; y1: number }[] = [];
  let y = 0;
  while (y < n) {
    if (profile[y] >= threshold) {
      const y0 = y;
      while (y < n && profile[y] >= threshold) y++;
      runs.push({ y0, y1: y - 1 });
    } else {
      y++;
    }
  }

  const diagnostics: Diagnostic[] = [];
  const clusters: BandCluster[] = [];
  for (const run of runs) {
    if (!spend(budget, run.y1 - run.y0 + 1)) {
      return fail("budget-exhausted", [
        {
          code: "iteration-budget-exhausted",
          severity: "error",
          message: "峰区精修超出迭代预算",
          location: { path: "detectBands.runs", y0: run.y0, y1: run.y1 },
        },
      ]);
    }
    // 区段内局部极大（处理饱和平台与重叠双峰）
    const peaks: DetectedPeak[] = [];
    let py = run.y0;
    while (py <= run.y1) {
      if (
        profile[py] >= profile[Math.max(run.y0, py - 1)] &&
        profile[py] >= profile[Math.min(run.y1, py + 1)]
      ) {
        // 平台：取平台中心
        let pend = py;
        while (pend + 1 <= run.y1 && profile[pend + 1] === profile[py]) pend++;
        const cy = Math.round((py + pend) / 2);
        const height = profile[py];
        peaks.push({
          y: cy,
          height,
          prominence: height - baseline,
          saturated: height >= opts.saturationLevel,
        });
        py = pend + 1;
      } else {
        py++;
      }
    }
    if (peaks.length === 0) continue;
    // 噪声抖动过滤：间距过小或峰谷下凹不足的峰合并（保留更高者）
    const merged: DetectedPeak[] = [];
    for (const peak of peaks) {
      const prev = merged[merged.length - 1];
      if (prev) {
        const gap = peak.y - prev.y;
        let valley = Infinity;
        for (let vy = prev.y; vy <= peak.y; vy++) valley = Math.min(valley, profile[vy]);
        const dip = Math.min(prev.height, peak.height) - valley;
        if (gap < opts.minSeparationPx || dip < 0.025 * Math.min(prev.height, peak.height)) {
          if (peak.height > prev.height) merged[merged.length - 1] = peak;
          continue;
        }
      }
      merged.push(peak);
    }
    // 合并过近的峰为 overlap 簇
    const groups: DetectedPeak[][] = [[merged[0]]];
    for (let i = 1; i < merged.length; i++) {
      const prev = groups[groups.length - 1];
      if (merged[i].y - prev[prev.length - 1].y < 2 * opts.minSeparationPx) {
        prev.push(merged[i]);
      } else {
        groups.push([merged[i]]);
      }
    }
    for (const group of groups) {
      const yMin = Math.min(...group.map((p) => p.y));
      const yMax = Math.max(...group.map((p) => p.y));
      const saturated = group.some((p) => p.saturated);
      // 拖尾检测：峰后窗口均值显著高于基线
      const tailStart = Math.min(n - 1, yMax + 2);
      const tailEnd = Math.min(n - 1, yMax + opts.smearWindowPx);
      let tailSum = 0;
      let tailN = 0;
      for (let ty = tailStart; ty <= tailEnd; ty++) {
        tailSum += profile[ty];
        tailN++;
      }
      const smeared = tailN > 0 && tailSum / tailN > baseline + opts.prominence * 0.4;
      clusters.push({
        kind: group.length > 1 ? "overlap" : "single",
        yMin,
        yMax,
        peaks: group,
        saturated,
        smeared,
      });
      if (saturated) {
        diagnostics.push({
          code: "saturated-band",
          severity: "warning",
          message: "条带饱和，中心不可唯一确定，只能标为候选",
          location: { path: "detectBands.clusters", y: yMin },
        });
      }
      if (group.length > 1) {
        diagnostics.push({
          code: "overlapping-bands",
          severity: "warning",
          message: "两条带重叠，只能给出区间",
          location: { path: "detectBands.clusters", yMin, yMax },
        });
      }
    }
  }
  clusters.sort((a, b) => a.yMin - b.yMin);
  return ok(clusters, diagnostics);
}
