import type { Diagnostic, Qty } from './types.js';
import type { LaneProfile } from './geometry.js';

export interface DetectedPeak {
  bandId: string;
  laneId: string;
  v: number;
  u: number;
  height: number;
  /** 高斯/局部宽度（像素） */
  widthPx: number;
  saturated: boolean;
  tailing: boolean;
  /** 与邻近峰重叠（两峰间距小于半宽和） */
  overlapsWith: string[];
  /** 无法唯一决定时保留全部合法候选（峰顶点） */
  candidateCenters: number[];
  /** 区间表达（像素 v 范围） */
  intervalPx?: [number, number];
  diagnostics: Diagnostic[];
}

export interface PeakParams {
  ruleVersion: string;
  minProminence: number;   // 相对背景的最小峰高
  satSaturationCount: number; // 一行内饱和像素 >= 该值判为饱和带
  curvatureWarnPx: number;
  laneCurvaturePx: number;
  centerU: (v: number) => number;
  halfWidthPx: number;
}

function qty(value: number, unit: string, basis?: string): Qty {
  return { value, unit, basis };
}

/**
 * 在一维剖面上检测峰。饱和/拖尾/重叠只产生“候选或区间”，不伪装成唯一定位。
 */
export function detectPeaks(profile: LaneProfile, params: PeakParams): DetectedPeak[] {
  const { intensity, v, saturation } = profile;
  const peaks: DetectedPeak[] = [];
  const n = intensity.length;
  if (n < 3) return peaks;

  // 背景估计：剖面最低 20% 的均值
  const sorted = [...intensity].sort((a, b) => a - b);
  const bg = sorted[Math.floor(sorted.length * 0.2)] ?? 0;
  const range = profile.maxIntensity - bg || 1;
  const threshold = bg + params.minProminence * range;

  let i = 1;
  let idx = 0;
  while (i < n - 1) {
    if (intensity[i] > intensity[i - 1] && intensity[i] >= intensity[i + 1] && intensity[i] > threshold) {
      // 找到一个局部最大，扩展为峰区间直到跌回接近背景
      let l = i;
      while (l > 0 && intensity[l - 1] > bg + 0.15 * range) l--;
      let r = i;
      while (r < n - 1 && intensity[r + 1] > bg + 0.15 * range) r++;
      const width = Math.max(1, r - l);
      const satCount = saturation.slice(l, r + 1).reduce((a, b) => a + b, 0);
      const saturated = satCount >= params.satSaturationCount;

      // 平台顶（饱和）：在平台内保留多个合法候选中心，而不是取中点伪装唯一
      const candidateCenters: number[] = [];
      if (saturated) {
        const topLevel = intensity[i];
        for (let k = l; k <= r; k++) {
          if (topLevel - intensity[k] <= 0.02 * range) candidateCenters.push(v[k]);
        }
      } else {
        candidateCenters.push(v[i]);
      }

      // 拖尾：两侧下降速率显著不对称
      const leftDrop = intensity[i] - intensity[Math.max(l, i - width)];
      const rightDrop = intensity[i] - intensity[Math.min(n - 1, i + width)];
      const tailing = rightDrop > 0 && leftDrop > 1.8 * rightDrop + 1e-9;

      const bandId = `${profile.laneId}::b${String(idx + 1).padStart(2, '0')}`;
      const diags: Diagnostic[] = [];
      if (saturated) {
        diags.push({
          code: 'SATURATED_REGION',
          severity: 'warning',
          message: `条带 ${bandId} 触及饱和平台，峰顶中心不可唯一确定`,
          location: { laneId: profile.laneId, bandId, rangePx: [v[l], v[r]] },
          affected: [bandId]
        });
      }
      if (tailing) {
        diags.push({
          code: 'BAND_TAILING',
          severity: 'warning',
          message: `条带 ${bandId} 存在拖尾，迁移位置只能作为候选/区间`,
          location: { laneId: profile.laneId, bandId, rangePx: [v[l], v[r]] },
          affected: [bandId]
        });
      }
      peaks.push({
        bandId,
        laneId: profile.laneId,
        v: v[i],
        u: params.centerU(v[i]),
        height: intensity[i],
        widthPx: width,
        saturated,
        tailing,
        overlapsWith: [],
        candidateCenters: dedupeSorted(candidateCenters),
        intervalPx: saturated || tailing ? [v[l], v[r]] : undefined,
        diagnostics: diags
      });
      idx++;
      i = r + 1;
      continue;
    }
    i++;
  }

  // 重叠：两峰区间相交或间距小于半宽和
  for (let a = 0; a < peaks.length; a++) {
    for (let b = a + 1; b < peaks.length; b++) {
      const pa = peaks[a];
      const pb = peaks[b];
      const gap = Math.abs(pb.v - pa.v);
      if (gap < (pa.widthPx + pb.widthPx) / 2) {
        pa.overlapsWith.push(pb.bandId);
        pb.overlapsWith.push(pa.bandId);
        const d: Diagnostic = {
          code: 'BANDS_OVERLAP',
          severity: 'warning',
          message: `条带 ${pa.bandId} 与 ${pb.bandId} 重叠，迁移位置保留为候选/区间`,
          location: { laneId: profile.laneId, bandId: pa.bandId, rangePx: [Math.min(pa.v, pb.v), Math.max(pa.v, pb.v)] },
          affected: [pa.bandId, pb.bandId]
        };
        pa.diagnostics.push(d);
        pb.diagnostics.push({ ...d, location: { ...d.location, bandId: pb.bandId } });
        // 重叠时扩充候选中心
        pa.candidateCenters = dedupeSorted([...pa.candidateCenters, pb.v]);
        pb.candidateCenters = dedupeSorted([...pb.candidateCenters, pa.v]);
        pa.intervalPx = unionRange(pa.intervalPx, pb.intervalPx ?? [pb.v, pb.v]);
        pb.intervalPx = pa.intervalPx;
      }
    }
  }

  // 弯曲：微笑使同一显示高度不等于同一分子量 —— 标注到该 lane 全部条带
  if (params.laneCurvaturePx > params.curvatureWarnPx) {
    for (const p of peaks) {
      p.diagnostics.push({
        code: 'LANE_CURVED_SMILE',
        severity: 'warning',
        message: `泳道 ${profile.laneId} 弯曲 ${params.laneCurvaturePx.toFixed(1)}px，必须使用沿曲线的局部标尺`,
        location: { laneId: profile.laneId, bandId: p.bandId, atPx: { u: params.centerU(p.v), v: p.v } },
        affected: peaks.map((x) => x.bandId)
      });
    }
  }

  return peaks;
}

function dedupeSorted(xs: number[]): number[] {
  return [...new Set(xs.map((x) => Math.round(x * 10) / 10))].sort((a, b) => a - b);
}

function unionRange(a?: [number, number], b?: [number, number]): [number, number] {
  const lo = Math.min(a?.[0] ?? Infinity, b?.[0] ?? Infinity);
  const hi = Math.max(a?.[1] ?? -Infinity, b?.[1] ?? -Infinity);
  return [lo, hi];
}

export function pxQty(v: number): Qty {
  return qty(v, 'px', 'original-frame:top-left');
}
