import type { BandAnnotation, ImageMaterial, LaneAnnotation, PxPoint } from './types';
import { pointAtArcLength, projectToLane } from './geometry';
import { stableId } from '../shared/ids';

export const DETECTION_PARAM_VERSION = 'detect.v3';

export interface DetectedPeak {
  s: number;
  center: PxPoint;
  peakIntensity: number;
  saturated: boolean;
  sigmaY: number;
  tailed: boolean;
}

/**
 * 沿泳道法线方向积分，生成弧长-强度轮廓。
 * 弯曲泳道必须沿中心线采样，这正是“同一高度≠同一分子量”的处理方式。
 */
export function laneIntensityProfile(
  image: ImageMaterial,
  lane: LaneAnnotation,
  step = 2,
): { s: number; intensity: number; center: PxPoint }[] {
  const total = laneTotalLength(lane);
  const samples: { s: number; intensity: number; center: PxPoint }[] = [];
  for (let s = 0; s <= total; s += step) {
    const { point, tangentX, tangentY } = pointAtArcLength(lane.centerline.points, s);
    const nx = -tangentY;
    const ny = tangentX;
    const half = lane.halfWidthPx;
    let sum = 0;
    let count = 0;
    for (let off = -half; off <= half; off += 2) {
      const x = Math.round(point.x + nx * off);
      const y = Math.round(point.y + ny * off);
      if (x >= 0 && y >= 0 && x < image.width && y < image.height) {
        sum += image.grayscale[y * image.width + x]!;
        count++;
      }
    }
    samples.push({ s, intensity: count ? sum / count : 0, center: point });
  }
  return samples;
}

export function laneTotalLength(lane: LaneAnnotation): number {
  const pts = lane.centerline.points;
  let len = 0;
  for (let i = 1; i < pts.length; i++) {
    len += Math.hypot(pts[i]!.x - pts[i - 1]!.x, pts[i]!.y - pts[i - 1]!.y);
  }
  return len;
}

/** 从弧长轮廓检测峰值，分类饱和/拖尾，估计纵向半高宽。 */
export function detectPeaks(
  image: ImageMaterial,
  lane: LaneAnnotation,
  opts: { minProminence?: number; saturationLevel?: number } = {},
): DetectedPeak[] {
  const minProminence = opts.minProminence ?? 22;
  const saturationLevel = opts.saturationLevel ?? 254;
  const profile = laneIntensityProfile(image, lane);
  if (profile.length < 3) return [];
  const baseline = Math.min(...profile.map((p) => p.intensity));
  const peaks: DetectedPeak[] = [];
  for (let i = 1; i < profile.length - 1; i++) {
    const prev = profile[i - 1]!;
    const cur = profile[i]!;
    const next = profile[i + 1]!;
    if (cur.intensity >= prev.intensity && cur.intensity >= next.intensity && cur.intensity - baseline >= minProminence) {
      const half = (cur.intensity + baseline) / 2;
      let lo = i;
      while (lo > 0 && profile[lo]!.intensity > half) lo--;
      let hi = i;
      while (hi < profile.length - 1 && profile[hi]!.intensity > half) hi++;
      const sigmaY = Math.max(2, (profile[hi]!.s - profile[lo]!.s) / 2);
      const upperMass = cur.s - profile[lo]!.s;
      const lowerMass = profile[hi]!.s - cur.s;
      const tailed = lowerMass > upperMass * 1.6;
      peaks.push({
        s: cur.s,
        center: cur.center,
        peakIntensity: Math.round(cur.intensity),
        saturated: cur.intensity >= saturationLevel,
        sigmaY,
        tailed,
      });
    }
  }
  // 合并过近的重复峰（小于 3px 的采样抖动）。
  const merged: DetectedPeak[] = [];
  for (const pk of peaks) {
    const last = merged[merged.length - 1];
    if (last && Math.abs(pk.s - last.s) < 3) {
      if (pk.peakIntensity > last.peakIntensity) merged[merged.length - 1] = pk;
    } else {
      merged.push(pk);
    }
  }
  return merged;
}

/** 将检测峰转为自动候选条带标注（带像素级来源）。 */
export function peaksToBands(
  image: ImageMaterial,
  lane: LaneAnnotation,
  producerEventId: string,
): BandAnnotation[] {
  const peaks = detectPeaks(image, lane);
  return peaks.map((pk) => {
    const proj = projectToLane(lane, pk.center);
    return {
      bandId: stableId('band', lane.laneId, Math.round(pk.s * 100), pk.peakIntensity, DETECTION_PARAM_VERSION),
      laneId: lane.laneId,
      center: { x: Math.round(pk.center.x), y: Math.round(pk.center.y), frame: 'original-pixel' },
      arcLengthPx: Math.round(proj.s * 100) / 100,
      peakIntensity: pk.peakIntensity,
      saturated: pk.saturated,
      overlapsWith: [],
      tailed: pk.tailed,
      provenance: {
        role: 'auto-candidate',
        frame: 'original-pixel',
        producerEventId,
        confidence: pk.saturated ? 0.4 : 0.85,
      },
    };
  });
}

/** 计算同泳道内重叠对（中心弧长距 < 半高宽和）。这里用固定几何阈值 8px。 */
export function annotateOverlaps(bands: BandAnnotation[]): BandAnnotation[] {
  const byLane = new Map<string, BandAnnotation[]>();
  for (const b of bands) {
    const arr = byLane.get(b.laneId) ?? [];
    arr.push(b);
    byLane.set(b.laneId, arr);
  }
  const out = bands.map((b) => ({ ...b, overlapsWith: [] as string[] }));
  const index = new Map(out.map((b) => [b.bandId, b]));
  for (const arr of byLane.values()) {
    for (let i = 0; i < arr.length; i++) {
      for (let j = i + 1; j < arr.length; j++) {
        const a = arr[i]!;
        const b = arr[j]!;
        const da = (a.arcLengthPx ?? 0) - (b.arcLengthPx ?? 0);
        if (Math.abs(da) < 8) {
          index.get(a.bandId)!.overlapsWith.push(b.bandId);
          index.get(b.bandId)!.overlapsWith.push(a.bandId);
        }
      }
    }
  }
  return out;
}
