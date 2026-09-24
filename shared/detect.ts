import { Outcome, ok, resourceExhausted } from './result.js';
import { BandEvidence } from './bands.js';
import { LaneCurve, centerlineXAt } from './lanes.js';
import { stableId } from './hash.js';

/**
 * Automatic band candidate detection along a lane curve.
 * Budget-limited: exceeding the sample budget is a resource-exhausted outcome,
 * distinct from corrupt input or semantic unsolvability.
 */

export interface GrayImage {
  width: number;
  height: number;
  /** row-major grayscale 0..255 */
  pixels: Uint8Array;
}

export interface DetectParams {
  threshold: number; // min profile intensity to consider a peak
  minPeakDistancePx: number;
  maxSamples: number; // resource budget
}

export const DETECT_PARAM_VERSION = 'detect.profile.v1';

export function detectBands(
  image: GrayImage,
  lane: LaneCurve,
  params: DetectParams,
): Outcome<BandEvidence[]> {
  const y0 = Math.max(0, Math.floor(Math.min(...lane.centerline.map((p) => p.y))));
  const y1 = Math.min(image.height - 1, Math.ceil(Math.max(...lane.centerline.map((p) => p.y))));
  const samples = y1 - y0 + 1;
  if (samples > params.maxSamples) {
    return resourceExhausted({
      code: 'BUDGET_EXHAUSTED',
      message: `lane ${lane.laneId} needs ${samples} profile samples, budget is ${params.maxSamples}`,
      at: { laneId: lane.laneId },
    });
  }
  const half = Math.max(1, Math.floor(lane.halfWidth) - 1);
  const profile = new Float64Array(samples);
  for (let y = y0; y <= y1; y++) {
    const cx = Math.round(centerlineXAt(lane, y));
    let sum = 0;
    let n = 0;
    for (let dx = -half; dx <= half; dx++) {
      const x = cx + dx;
      if (x < 0 || x >= image.width) continue;
      sum += image.pixels[y * image.width + x]!;
      n++;
    }
    profile[y - y0] = n > 0 ? sum / n : 0;
  }
  // local maxima above threshold, separated by minPeakDistancePx
  const peaks: { y: number; v: number }[] = [];
  for (let i = 1; i < samples - 1; i++) {
    const v = profile[i]!;
    if (v >= params.threshold && v >= profile[i - 1]! && v >= profile[i + 1]!) {
      const y = y0 + i;
      const last = peaks[peaks.length - 1];
      if (last && y - last.y < params.minPeakDistancePx) {
        if (v > last.v) peaks[peaks.length - 1] = { y, v };
      } else {
        peaks.push({ y, v });
      }
    }
  }
  const bands: BandEvidence[] = peaks.map((p) => {
    // half-height extent for contour + tail
    const halfHeight = p.v / 2;
    let top = p.y;
    while (top > y0 && profile[top - y0]! > halfHeight) top--;
    let bottom = p.y;
    while (bottom < y1 && profile[bottom - y0]! > halfHeight) bottom++;
    const cx = Math.round(centerlineXAt(lane, p.y));
    let maxIntensity = 0;
    for (let y = top; y <= bottom; y++) {
      const x = Math.round(centerlineXAt(lane, y));
      for (let dx = -half; dx <= half; dx++) {
        const xx = x + dx;
        if (xx < 0 || xx >= image.width) continue;
        maxIntensity = Math.max(maxIntensity, image.pixels[y * image.width + xx]!);
      }
    }
    const mk = (x: number, y: number) => ({ x, y, space: 'image-px' as const, imageId: lane.imageId });
    return {
      id: stableId('band', lane.laneId, p.y, Math.round(p.v)),
      laneId: lane.laneId,
      center: mk(cx, p.y),
      contour: [mk(cx - half, top), mk(cx + half, top), mk(cx + half, bottom), mk(cx - half, bottom)],
      maxIntensity,
      tailPx: Math.max(0, bottom - p.y - (p.y - top)),
      source: 'auto' as const,
    };
  });
  return ok(bands);
}
