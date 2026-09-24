import type {
  CalibrationParams,
  DerivationBase,
  Diagnostic,
  LaneProfileResult
} from '../types';
import type { OrientedImage } from '../image/types';
import { centerline } from './geometry';
import type { LaneBoundary } from '../types';
import { contentId, digestOf } from '../ids';

export interface ProfileInput {
  image: OrientedImage;
  boundary: LaneBoundary;
  params: CalibrationParams;
  parents: string[];
  now: string;
}

function sampleGray(img: OrientedImage, x: number, y: number): number | null {
  const xi = Math.round(x), yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= img.width || yi >= img.height) return null;
  return img.data[yi * img.width + xi];
}

// 沿泳道中心线逐像素做横向平均（凝胶暗带 => profile 取“暗度” 255-gray 方便找峰）。
export function buildLaneProfile(input: ProfileInput): {
  result: LaneProfileResult;
  diagnostics: Diagnostic[];
} {
  const { image, boundary, params, parents, now } = input;
  const diagnostics: Diagnostic[] = [];
  const curve = centerline(boundary);
  if (curve.length < 8) {
    diagnostics.push({
      code: 'LANE_TOO_SHORT',
      kind: 'incomplete-input',
      message: `泳道 ${boundary.laneCode} 有效像素长度不足`,
      location: { laneId: boundary.id, field: 'polygon', unit: 'pixel', frame: 'oriented-image' }
    });
  }
  const halfW = Math.max(2, Math.round(params.band.windowHalfWidthPx));
  const profile: number[] = [];
  for (const p of curve) {
    let sum = 0, cnt = 0;
    for (let dx = -halfW; dx <= halfW; dx++) {
      const v = sampleGray(image, p.x + dx, p.y);
      if (v !== null) { sum += 255 - v; cnt++; }
    }
    profile.push(cnt ? sum / cnt : 0);
  }
  const id = contentId('laneProfile', {
    lane: boundary.laneCode,
    img: image.parentSha256,
    rot: image.rotationCw,
    flip: image.flipH,
    poly: boundary.polygon,
    pv: params.paramVersion
  });
  const base: DerivationBase = {
    id,
    type: 'lane-profile',
    parentIds: parents,
    inputDigest: digestOf({ img: image.parentSha256, poly: boundary.polygon, pv: params.paramVersion }),
    paramVersion: params.paramVersion,
    computedAt: now,
    diagnostics
  };
  const result: LaneProfileResult = {
    ...base,
    laneCode: boundary.laneCode,
    curve,
    profile,
    validRegion: curve.length
      ? { s0: curve[0].s, s1: curve[curve.length - 1].s }
      : { s0: 0, s1: 0 }
  };
  return { result, diagnostics };
}
