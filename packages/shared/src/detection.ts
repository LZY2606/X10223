import { channelStats } from './image.js';
import { projectToPolyline, type ProjectedPoint } from './geometry.js';
import type {
  BandObservationMaterial,
  DomainValue,
  Diagnostic,
  GelImageMaterial,
  LaneSketchMaterial,
  PixelPoint
} from './types.js';
import { stableDigest } from './hash.js';

export interface DetectionParams {
  saturationThreshold: number; // 灰度阈值，>= 即饱和
  smearWidthPx: number; // 半高宽超过该值视为拖尾
  overlapMergeGapPx: number; // 两个峰顶距离小于 半宽和+gap 视为重叠
  minPeakProminence: number;
  resourceBudgetPixels: number;
}

export const DEFAULT_DETECTION_PARAMS: DetectionParams = {
  saturationThreshold: 250,
  smearWidthPx: 14,
  overlapMergeGapPx: 3,
  minPeakProminence: 28,
  resourceBudgetPixels: 64_000_000
};

export interface RawPeak {
  s: number;
  center: PixelPoint;
  intensity: number;
  widthPx: number;
  saturated: boolean;
  smeared: boolean;
  overlapGroupId: string | null;
}

function idx(img: GelImageMaterial, x: number, y: number): number {
  const xi = Math.max(0, Math.min(img.width - 1, Math.round(x)));
  const yi = Math.max(0, Math.min(img.height - 1, Math.round(y)));
  return img.grayscale[yi * img.width + xi] as number;
}

/** 沿 lane 中心曲线扫描横向条带内的 1D 强度曲线（对弯曲泳道沿弧长采样）。 */
export function laneProfile(img: GelImageMaterial, lane: LaneSketchMaterial, step = 1): { s: number; value: number; saturated: boolean }[] {
  const out: { s: number; value: number; saturated: boolean }[] = [];
  let cum = 0;
  for (let i = 0; i < lane.centerline.length - 1; i++) {
    const a = lane.centerline[i]!;
    const b = lane.centerline[i + 1]!;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    const vx = (b.x - a.x) / (segLen || 1);
    const vy = (b.y - a.y) / (segLen || 1);
    const nx = -vy;
    const ny = vx;
    for (let t = 0; t < segLen; t += step) {
      const cx = a.x + vx * t;
      const cy = a.y + vy * t;
      let sum = 0;
      let count = 0;
      let sat = 0;
      for (let off = -lane.halfWidthPx; off <= lane.halfWidthPx; off += 2) {
        const v = idx(img, cx + nx * off, cy + ny * off);
        sum += v;
        count++;
        if (v >= 250) sat++;
      }
      out.push({ s: cum + t, value: sum / Math.max(1, count), saturated: sat / Math.max(1, count) > 0.4 });
    }
    cum += segLen;
  }
  return out;
}

function smooth(profile: { s: number; value: number; saturated: boolean }[], radius: number): number[] {
  return profile.map((_, i) => {
    let s = 0;
    let n = 0;
    for (let j = Math.max(0, i - radius); j <= Math.min(profile.length - 1, i + radius); j++) {
      s += profile[j]!.value;
      n++;
    }
    return s / n;
  });
}

/** 峰顶检测 + 饱和/拖尾/重叠标注。返回自动候选条带（像素级中心来源）。 */
export function detectBands(
  img: GelImageMaterial,
  lane: LaneSketchMaterial,
  params: DetectionParams
): { peaks: RawPeak[]; diagnostics: Diagnostic[]; overlapGroups: { id: string; ordinals: number[] }[] } {
  // 资源预算：格式完好但资源不足必须是独立结果，而不是静默截断。
  channelStats(img.grayscale as Uint8Array, params.resourceBudgetPixels);
  const diagnostics: Diagnostic[] = [];
  const profile = laneProfile(img, lane);
  const sm = smooth(profile, 2);
  const peaks: { s: number; half: number; intensity: number; saturated: boolean }[] = [];
  for (let i = 2; i < sm.length - 2; i++) {
    const v = sm[i]!;
    if (
      v > sm[i - 1]! && v >= sm[i + 1]! &&
      v - Math.min(sm[Math.max(0, i - 8)]!, sm[Math.min(sm.length - 1, i + 8)]!) > params.minPeakProminence
    ) {
      const half = halfWidth(sm, i, v);
      peaks.push({
        s: profile[i]!.s,
        half,
        intensity: Math.round(v),
        saturated: profile.slice(Math.max(0, i - 2), i + 3).some((p) => p.saturated)
      });
    }
  }
  // 合并几乎重合的峰顶
  const merged: typeof peaks = [];
  for (const p of peaks) {
    const last = merged[merged.length - 1];
    if (last && p.s - last.s < 4) {
      last.s = (last.s + p.s) / 2;
      last.intensity = Math.max(last.intensity, p.intensity);
      last.saturated = last.saturated || p.saturated;
    } else {
      merged.push({ ...p });
    }
  }
  const groups: number[][] = merged.map((_, i) => [i]);
  for (let i = 1; i < merged.length; i++) {
    const prev = merged[i - 1]!;
    const cur = merged[i]!;
    const touch = cur.s - prev.s < prev.half + cur.half + params.overlapMergeGapPx;
    if (touch) {
      const g = groups[i - 1]!;
      g.push(i);
      groups[i] = g;
    }
  }
  const groupOf = new Map<number, number>();
  groups.forEach((g, gi) => g.forEach((idxPeak) => groupOf.set(idxPeak, gi)));

  const groupByPeak = new Map<number, number>();
  groups.forEach((g, gi) => {
    if (g.length > 1) g.forEach((idxPeak) => groupByPeak.set(idxPeak, gi));
  });
  const overlapGroups: { id: string; ordinals: number[] }[] = [];
  groups.forEach((g, gi) => {
    if (g.length > 1) overlapGroups.push({ id: `ov-${lane.id}-${gi}`, ordinals: g });
  });
  const rawPeaks: RawPeak[] = merged.map((p, i) => {
    const center = pointAtS(lane, p.s);
    const proj = projectToPolyline(center, lane.centerline);
    const smeared = p.half * 2 > params.smearWidthPx;
    if (p.saturated) {
      diagnostics.push({
        code: 'SATURATED_BAND',
        severity: 'warning',
        message: `lane ${lane.id} 弧长 ${p.s.toFixed(1)}px 处条带饱和，峰顶强度只能作为候选`,
        location: { materialId: lane.id, point: center }
      });
    }
    if (smeared) {
      diagnostics.push({
        code: 'SMEARED_BAND',
        severity: 'warning',
        message: `半高宽 ${(p.half * 2).toFixed(1)}px 超过阈值，判定拖尾，只能给区间`,
        location: { materialId: lane.id, point: center }
      });
    }
    return {
      s: p.s,
      center: { ...center, ref: { ...center.ref, frameKind: 'raw-image' } },
      intensity: p.intensity,
      widthPx: p.half * 2,
      saturated: p.saturated,
      smeared,
      overlapGroupId: groupByPeak.has(i) ? `ov-${lane.id}-${groupByPeak.get(i)}` : null
    };
    void proj;
  });

  overlapGroups.forEach((og) => {
    og.ordinals.forEach((i2) => {
      diagnostics.push({
        code: 'OVERLAPPING_BANDS',
        severity: 'warning',
        message: `重叠组 ${og.id}: 两条带无法唯一指派，保留全部合法候选`,
        location: { materialId: lane.id, point: rawPeaks[i2]!.center }
      });
    });
  });

  return { peaks: rawPeaks, diagnostics, overlapGroups };
}

function halfWidth(sm: number[], i: number, v: number): number {
  const base = Math.min(...sm.slice(Math.max(0, i - 10), i).concat(sm.slice(i + 1, i + 11)));
  const half = (v + base) / 2;
  let left = i;
  let right = i;
  while (left > 0 && sm[left]! > half) left--;
  while (right < sm.length - 1 && sm[right]! > half) right++;
  return Math.max(1.5, (right - left) / 2);
}

export function pointAtS(lane: LaneSketchMaterial, s: number): PixelPoint {
  let cum = 0;
  for (let i = 0; i < lane.centerline.length - 1; i++) {
    const a = lane.centerline[i]!;
    const b = lane.centerline[i + 1]!;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (cum + segLen >= s) {
      const t = (s - cum) / (segLen || 1e-9);
      return {
        x: a.x + t * (b.x - a.x),
        y: a.y + t * (b.y - a.y),
        ref: { frameId: lane.imageId, frameKind: 'raw-image', unit: 'pixel' }
      };
    }
    cum += segLen;
  }
  const last = lane.centerline[lane.centerline.length - 1]!;
  return { x: last.x, y: last.y, ref: { frameId: lane.imageId, frameKind: 'raw-image', unit: 'pixel' } };
}

export function bandId(laneId: string, s: number, ordinal: number): string {
  return `band-${laneId}-${ordinal}-${stableDigest({ laneId, s: Math.round(s * 10) }).slice(0, 8)}`;
}

export function toBandMaterial(
  img: GelImageMaterial,
  lane: LaneSketchMaterial,
  peak: RawPeak,
  ordinal: number,
  overlapGroupId: string | null
): BandObservationMaterial {
  const proj: ProjectedPoint = projectToPolyline(peak.center, lane.centerline);
  const arc: DomainValue = {
    value: proj.arcLength,
    unit: 'pixel',
    raw: `${proj.arcLength.toFixed(2)} px`,
    ref: { frameId: lane.id, frameKind: 'lane-local', axis: 's', unit: 'pixel' }
  };
  return {
    kind: 'band-observation',
    id: bandId(lane.id, peak.s, ordinal),
    version: 1,
    parentVersionId: null,
    imageId: img.id,
    laneId: lane.id,
    center: peak.center,
    widthPx: peak.widthPx,
    arcLength: arc,
    peakIntensity: { value: peak.intensity, unit: 'gray', raw: `${peak.intensity}/255 gray` },
    saturated: peak.saturated,
    smeared: peak.smeared,
    overlapGroupId,
    createdAt: new Date(0).toISOString()
  };
}
