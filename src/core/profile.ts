/**
 * 强度轮廓分析：峰检测 + 光度证据（饱和、拖尾、重叠/分辨数、残差）。
 * 饱和条带、拖尾和重叠不能唯一决定 -> 只能标 candidate / interval，
 * 无法唯一决定时保留全部合法候选。
 */
import type { Diagnostic } from './types.js';

export interface DetectedPeak {
  u: number;
  height: number;
  leftBase: number;
  rightBase: number;
  fwhm: number;
  clippedFraction: number;
  asymmetry: number;
  resolvedPeaks: number;
}

export interface PeakParams {
  /** 饱和阈值（8 位） */
  saturationLevel: number;
  /** 最小峰高（背景之上） */
  minHeight: number;
  /** 分辨两条峰的最小谷深比例（0..1） */
  resolutionValley: number;
  /** 判定拖尾的不对称比阈值 */
  tailAsymmetry: number;
}

export const DEFAULT_PEAK_PARAMS: PeakParams = {
  saturationLevel: 254,
  minHeight: 12,
  resolutionValley: 0.6,
  tailAsymmetry: 1.8
};

function smooth(v: number[], radius: number): number[] {
  return v.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < v.length) {
        s += v[j]!;
        n++;
      }
    }
    return s / n;
  });
}

/** 在平滑后的轮廓上寻找局部极大，合并分辨不足的峰 */
export function detectPeaks(
  profile: { u: number; intensity: number }[],
  params: PeakParams
): { peaks: DetectedPeak[]; diagnostics: Diagnostic[]; smoothed: number[] } {
  const diagnostics: Diagnostic[] = [];
  if (profile.length < 5) {
    return {
      peaks: [],
      smoothed: profile.map((p) => p.intensity),
      diagnostics: [
        {
          code: 'PROFILE_TOO_SHORT',
          severity: 'error',
          message: '轮廓采样点不足，无法检测条带',
          failureClass: 'semantic-unsolvable',
          location: { field: 'profile' }
        }
      ]
    };
  }
  const baseline = Math.min(...profile.map((p) => p.intensity));
  const us = profile.map((p) => p.u);
  const sm = smooth(profile.map((p) => p.intensity), 2);
  const raw = profile.map((p) => p.intensity);

  const candidates: { idx: number; height: number }[] = [];
  for (let i = 2; i < sm.length - 2; i++) {
    if (
      sm[i]! > sm[i - 1]! &&
      sm[i]! >= sm[i + 1]! &&
      sm[i]! - baseline >= params.minHeight
    ) {
      candidates.push({ idx: i, height: sm[i]! });
    }
  }

  // 合并间隔过近、谷太浅的峰为一个重叠簇（resolvedPeaks 计数原始候选）
  const merged: DetectedPeak[] = [];
  for (const c of candidates) {
    const last = merged[merged.length - 1];
    if (last) {
      const between = sm.slice(last.u <= 0 ? 0 : 0);
      void between;
    }
    const h = sm[c.idx]!;
    // 峰底
    let l = c.idx;
    while (l > 0 && sm[l - 1]! < sm[l]!) l--;
    let rr = c.idx;
    while (rr < sm.length - 1 && sm[rr + 1]! < sm[rr]!) rr++;
    const half = baseline + (h - baseline) / 2;
    let lf = c.idx;
    while (lf > 0 && sm[lf]! > half) lf--;
    let rf = c.idx;
    while (rf < sm.length - 1 && sm[rf]! > half) rf++;
    merged.push({
      u: us[c.idx]!,
      height: h,
      leftBase: us[l]!,
      rightBase: us[rr]!,
      fwhm: us[rf]! - us[lf]!,
      clippedFraction: 0,
      asymmetry: 1,
      resolvedPeaks: 1
    });
  }

  // 合并重叠簇
  const clusters: DetectedPeak[] = [];
  for (const p of merged) {
    const last = clusters[clusters.length - 1];
    if (last && p.leftBase < last.rightBase) {
      const seg = sm.slice(
        Math.max(0, profile.findIndex((q) => q.u >= last.leftBase)),
        Math.min(sm.length, profile.findIndex((q) => q.u >= p.rightBase) + 1)
      );
      const valley = seg.length ? Math.min(...seg) : Math.min(last.height, p.height);
      const minH = Math.min(last.height, p.height);
      const resolved = valley < baseline + (minH - baseline) * params.resolutionValley;
      if (!resolved) {
        last.rightBase = Math.max(last.rightBase, p.rightBase);
        last.height = Math.max(last.height, p.height);
        last.u = (last.u + p.u) / 2;
        last.resolvedPeaks += 1;
        continue;
      }
    }
    clusters.push({ ...p });
  }

  // 光度证据：饱和比例与不对称（拖尾）
  for (const p of clusters) {
    const i0 = profile.findIndex((q) => q.u >= p.leftBase);
    const i1 = profile.findIndex((q) => q.u >= p.rightBase);
    const seg = raw.slice(Math.max(0, i0), i1 < 0 ? raw.length : i1 + 1);
    if (seg.length === 0) continue;
    const over = seg.filter((v) => v >= params.saturationLevel).length;
    p.clippedFraction = over / seg.length;
    const half = baseline + (p.height - baseline) / 2;
    let topL = i0;
    while (topL >= 0 && sm[topL]! > half) topL--;
    let topR = i1 < 0 ? sm.length - 1 : i1;
    while (topR < sm.length && sm[topR]! > half) topR++;
    const leftHalf = Math.max(1, profile[Math.max(0, topL + 1)]!.u - p.leftBase);
    const rightHalf = Math.max(1, p.rightBase - profile[Math.min(sm.length - 1, topR - 1)]!.u);
    p.asymmetry = rightHalf / leftHalf;
  }

  for (const p of clusters) {
    if (p.clippedFraction > 0.02) {
      diagnostics.push({
        code: 'SATURATED_BAND',
        severity: 'warning',
        message: '条带灰度触及饱和平台，中心位置存在裁切偏差，仅可作为候选',
        location: { field: 'intensity', y: Math.round(p.u) }
      });
    }
    if (p.asymmetry >= params.tailAsymmetry) {
      diagnostics.push({
        code: 'TAILING_BAND',
        severity: 'warning',
        message: '条带沿迁移方向拖尾，边界不对称，仅可作为候选',
        location: { field: 'intensity', y: Math.round(p.u) }
      });
    }
    if (p.resolvedPeaks > 1) {
      diagnostics.push({
        code: 'OVERLAPPING_BANDS',
        severity: 'warning',
        message: '两条带重叠且谷未充分分辨，分子量只能给出区间',
        location: { field: 'intensity', y: Math.round(p.u) }
      });
    }
  }

  return { peaks: clusters, diagnostics, smoothed: sm };
}
