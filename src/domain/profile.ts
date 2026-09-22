import type { ParamSet, ProfileSample, Diagnostic } from '../shared/types.js';
import type { PixelImage, ArcGeometry } from './geometry.js';
import { arcGeometry, crossSectionMean } from './geometry.js';
import type { LaneCurve } from '../shared/types.js';

export interface ProfileOutcome {
  laneId: string;
  profile: ProfileSample[];
  totalLength: number;
  usedPixels: number;
  diagnostics: Diagnostic[];
  geometry: ArcGeometry;
}

// 沿泳道曲线弧长等距采样；采样数受资源预算限制。
export function sampleLaneProfile(
  img: PixelImage,
  lane: LaneCurve,
  params: ParamSet,
): ProfileOutcome {
  const diagnostics: Diagnostic[] = [];
  const geometry = arcGeometry(lane.points);
  const step = 1; // 每像素一个 s 采样
  const n = Math.max(1, Math.floor(geometry.total / step));
  if (n > params.maxSamplesPerLane) {
    diagnostics.push({
      code: 'BUDGET_EXHAUSTED',
      message: `泳道 ${lane.laneId} 需要 ${n} 个采样，超过每道预算 ${params.maxSamplesPerLane}`,
      path: `lanes[${lane.ordinal}]`,
      detail: { required: n, limit: params.maxSamplesPerLane },
    });
    return { laneId: lane.laneId, profile: [], totalLength: geometry.total, usedPixels: 0, diagnostics, geometry };
  }
  const profile: ProfileSample[] = [];
  let used = 0;
  for (let k = 0; k <= n; k++) {
    const s = k * step;
    const cs = crossSectionMean(img, lane.points, s, lane.halfWidthPx);
    used += cs.samples;
    profile.push({
      s,
      intensity: cs.mean,
      saturated: cs.saturatedCount > 0,
    });
  }
  if (used > params.maxPixels) {
    diagnostics.push({
      code: 'BUDGET_EXHAUSTED',
      message: `泳道 ${lane.laneId} 使用 ${used} 像素，超过像素预算 ${params.maxPixels}`,
      path: `lanes[${lane.ordinal}]`,
      detail: { used, limit: params.maxPixels },
    });
  }
  return { laneId: lane.laneId, profile, totalLength: geometry.total, usedPixels: used, diagnostics, geometry };
}
