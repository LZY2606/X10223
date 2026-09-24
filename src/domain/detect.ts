import type { BandMaterial, ExposureMaterial, LaneMaterial, QtyInput } from "../shared/types.js";
import { pointAtArc, polylineLength } from "./geometry.js";
import { intensityAt, type RasterImage } from "./raster.js";

export interface AutoBand {
  laneId: string;
  center: { x: number; y: number; frame: "oriented-image-px" };
  profilePeak: number;
  peakWidthPx: number;
  saturated: boolean;
  shape: BandMaterial["shape"];
  tailing?: QtyInput;
}

export interface DetectOptions {
  minProminence?: number;
  saturationIntensity?: number;
  minSeparationPx?: number;
  laneHalfWidth?: number;
  sampleStepPx?: number;
}

export function detectBands(
  img: RasterImage,
  lane: LaneMaterial,
  exposure: ExposureMaterial,
  opts: DetectOptions = {}
): AutoBand[] {
  const minProminence = opts.minProminence ?? 18;
  const saturationIntensity = opts.saturationIntensity ?? exposure.saturationLevel;
  const minSeparation = opts.minSeparationPx ?? 8;
  const halfWidth = opts.laneHalfWidth ?? 10;
  const step = opts.sampleStepPx ?? 2;
  const length = polylineLength(lane.centerline);
  const profile: { arc: number; v: number }[] = [];

  for (let arc = 0; arc <= length; arc += step) {
    const { p } = pointAtArc(lane.centerline, arc);
    let sum = 0;
    let n = 0;
    for (let dx = -halfWidth; dx <= halfWidth; dx += 2) {
      sum += intensityAt(img, Math.round(p.x + dx), Math.round(p.y));
      n++;
    }
    profile.push({ arc, v: sum / n });
  }

  const baseline = Math.max(...profile.map((s) => s.v));
  const peaks: { arc: number; depth: number; width: number; v: number }[] = [];
  for (let i = 1; i < profile.length - 1; i++) {
    const cur = profile[i];
    const prev = profile[i - 1];
    const next = profile[i + 1];
    if (cur.v <= prev.v && cur.v <= next.v) {
      const depth = baseline - cur.v;
      if (depth >= minProminence) {
        let half = step;
        for (let j = i + 1; j < profile.length; j++) {
          if (baseline - profile[j].v < depth / 2) break;
          half += step;
        }
        peaks.push({ arc: cur.arc, depth, width: half * 2, v: cur.v });
      }
    }
  }

  peaks.sort((a, b) => b.depth - a.depth);
  const picked: typeof peaks = [];
  for (const pk of peaks) {
    if (picked.every((q) => Math.abs(q.arc - pk.arc) >= minSeparation)) picked.push(pk);
  }
  picked.sort((a, b) => a.arc - b.arc);

  return picked.map((pk) => {
    const { p } = pointAtArc(lane.centerline, pk.arc);
    const saturated = pk.v <= 255 - saturationIntensity;
    let after = pk;
    for (let j = profile.indexOf(profile.find((q) => q.arc === pk.arc)!) + 1; j < profile.length; j++) {
      if (baseline - profile[j].v < pk.depth / 4) {
        after = profile[j];
        break;
      }
    }
    const tailLen = after.arc - pk.arc;
    const tailed = tailLen > pk.width * 1.2;
    return {
      laneId: lane.id,
      center: { x: Math.round(p.x * 10) / 10, y: Math.round(p.y * 10) / 10, frame: "oriented-image-px" as const },
      profilePeak: Math.round(pk.v),
      peakWidthPx: Math.round(pk.width),
      saturated,
      shape: saturated ? "saturated" : tailed ? "tailed" : "sharp",
      tailing: tailed ? { value: String(Math.round(tailLen)), unit: "px" } : undefined
    };
  });
}
