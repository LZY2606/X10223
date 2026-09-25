import { PNG } from "pngjs";
import type { Point } from "../shared/domain.js";
import type { ParamPack } from "../shared/params.js";
import { rotatedDimensions } from "../shared/geometry.js";

export interface RawImage {
  width: number;
  height: number;
  gray: Float64Array;
  rgba: Buffer;
}

export function decodePng(buffer: Buffer): RawImage {
  const png = PNG.sync.read(buffer);
  const { width, height, data } = png;
  const gray = new Float64Array(width * height);
  for (let i = 0; i < width * height; i++) {
    const r = data[i * 4] ?? 0;
    const g = data[i * 4 + 1] ?? 0;
    const b = data[i * 4 + 2] ?? 0;
    gray[i] = 0.299 * r + 0.587 * g + 0.114 * b;
  }
  return { width, height, gray, rgba: Buffer.from(data) };
}

export function encodePng(img: Pick<RawImage, "width" | "height" | "rgba">): Buffer {
  const png = new PNG({ width: img.width, height: img.height });
  img.rgba.copy(png.data);
  return PNG.sync.write(png);
}

export function rotateCw(img: RawImage, clockwiseDegrees: number): RawImage {
  const norm = ((clockwiseDegrees % 360) + 360) % 360;
  if (norm === 0) {
    return { width: img.width, height: img.height, gray: Float64Array.from(img.gray), rgba: Buffer.from(img.rgba) };
  }
  const [width, height] = rotatedDimensions(img.width, img.height, norm);
  const rgba = Buffer.alloc(width * height * 4);
  const gray = new Float64Array(width * height);
  const map = (x: number, y: number): Point => {
    if (norm === 90) return { x: img.width - 1 - y, y: x };
    if (norm === 180) return { x: img.width - 1 - x, y: img.height - 1 - y };
    return { x: y, y: img.height - 1 - x };
  };
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const src = map(x, y);
      const si = (src.y * img.width + src.x) * 4;
      const di = (y * width + x) * 4;
      rgba[di] = img.rgba[si] ?? 0;
      rgba[di + 1] = img.rgba[si + 1] ?? 0;
      rgba[di + 2] = img.rgba[si + 2] ?? 0;
      rgba[di + 3] = 255;
      gray[y * width + x] = img.gray[src.y * img.width + src.x] ?? 0;
    }
  }
  return { width, height, gray, rgba };
}

function smooth(values: Float64Array, radius: number): Float64Array {
  const out = new Float64Array(values.length);
  for (let i = 0; i < values.length; i++) {
    let sum = 0;
    let n = 0;
    for (let k = -radius; k <= radius; k++) {
      const j = i + k;
      if (j >= 0 && j < values.length) {
        sum += values[j] ?? 0;
        n++;
      }
    }
    out[i] = sum / n;
  }
  return out;
}

export interface DetectedLane {
  seedX: number;
  halfWidth: number;
  polyline: Point[];
  profile: { s: number; y: number; x: number; intensity: number }[];
}

export interface DetectedBand {
  center: Point;
  arcS: number;
  widthPx: number;
  heightPx: number;
  peakIntensity: number;
  saturated: boolean;
  tailing: "none" | "right" | "left";
  overlapGroupKey: string | null;
}

export interface DetectionResult {
  lanes: DetectedLane[];
  bands: DetectedBand[][];
  pixelValueRange: [number, number];
}

export function detectGel(img: RawImage, params: ParamPack): DetectionResult {
  const { width, height, gray } = img;
  const colMean = new Float64Array(width);
  for (let x = 0; x < width; x++) {
    let sum = 0;
    for (let y = 0; y < height; y++) sum += gray[y * width + x] ?? 0;
    colMean[x] = sum / height;
  }
  const smoothed = smooth(colMean, 3);
  const globalMax = Math.max(...smoothed);
  const base = Math.min(...smoothed);
  const laneThresh = base + (globalMax - base) * 0.18;
  const seedXs: number[] = [];
  for (let x = 2; x < width - 2; x++) {
    const v = smoothed[x] ?? 0;
    if (v > laneThresh && v >= (smoothed[x - 1] ?? 0) && v > (smoothed[x + 1] ?? 0)) {
      if (seedXs.length === 0 || x - (seedXs[seedXs.length - 1] as number) > 24) seedXs.push(x);
    }
  }

  const lanes: DetectedLane[] = [];
  for (const seedX of seedXs) {
    let halfWidth = 10;
    for (let d = 4; d < 40; d++) {
      const l = smoothed[Math.max(0, seedX - d)] ?? 0;
      const r = smoothed[Math.min(width - 1, seedX + d)] ?? 0;
      if (l <= laneThresh && r <= laneThresh) {
        halfWidth = d;
        break;
      }
    }

    const polyline: Point[] = [];
    const step = 2;
    let prevX: number | null = null;
    for (let y = 0; y < height; y += step) {
      let m0 = 0;
      let m1 = 0;
      const from = Math.max(0, seedX - halfWidth);
      const to = Math.min(width - 1, seedX + halfWidth);
      for (let x = from; x <= to; x++) {
        const v = gray[y * width + x] ?? 0;
        m0 += v;
        m1 += v * x;
      }
      let cx = m0 > 0.0001 ? m1 / m0 : seedX;
      if (prevX !== null) cx = prevX + Math.max(-2.5, Math.min(2.5, cx - prevX));
      prevX = cx;
      polyline.push({ x: cx, y });
    }

    const profile: DetectedLane["profile"] = [];
    let cumulative = 0;
    for (let i = 0; i < polyline.length; i++) {
      const pt = polyline[i] as Point;
      if (i > 0) cumulative += Math.hypot(pt.x - (polyline[i - 1] as Point).x, pt.y - (polyline[i - 1] as Point).y);
      const from = Math.max(0, Math.round(pt.x - halfWidth));
      const to = Math.min(width - 1, Math.round(pt.x + halfWidth));
      let peakCross = 0;
      for (let x = from; x <= to; x++) peakCross = Math.max(peakCross, gray[pt.y * width + x] ?? 0);
      profile.push({ s: cumulative, y: pt.y, x: pt.x, intensity: peakCross });
    }
    lanes.push({ seedX, halfWidth, polyline, profile });
  }

  const bandsAll: DetectedBand[][] = [];
  let minV = 255;
  let maxV = 0;
  for (const lane of lanes) {
    const prof = lane.profile;
    const values = prof.map((p) => p.intensity);
    const peak = Math.max(...values);
    minV = Math.min(minV, Math.min(...values));
    maxV = Math.max(maxV, peak);
    const bandThresh = Math.min(...values) + (peak - Math.min(...values)) * params.bandDetectionThreshold;
    const runs: [number, number][] = [];
    let start = -1;
    for (let i = 0; i < prof.length; i++) {
      const above = (prof[i] as { intensity: number }).intensity >= bandThresh;
      if (above && start < 0) start = i;
      if ((!above || i === prof.length - 1) && start >= 0) {
        runs.push([start, i - 1 >= start ? i - 1 : start]);
        start = -1;
      }
    }

    let bands: DetectedBand[] = [];
    for (const [r0, r1] of runs) {
      const rawMaxima: number[] = [];
      for (let i = r0; i <= r1; i++) {
        const v = prof[i] as { intensity: number };
        const left = prof[Math.max(r0, i - 1)] as { intensity: number };
        const right = prof[Math.min(r1, i + 1)] as { intensity: number };
        if (v.intensity >= left.intensity && v.intensity >= right.intensity && (i === r0 || i === r1 || v.intensity > left.intensity || v.intensity > right.intensity)) {
          rawMaxima.push(i);
        }
      }
      const maxima: number[] = [];
      for (const mi of rawMaxima) {
        const last = maxima[maxima.length - 1];
        if (last === undefined || mi - last > 2) {
          maxima.push(mi);
        } else if ((prof[mi] as { intensity: number }).intensity > (prof[last] as { intensity: number }).intensity) {
          maxima[maxima.length - 1] = mi;
        }
      }
      const overlap = maxima.length > 1;
      const groupKey = overlap ? `ov-${lane.seedX}-${r0}-${r1}` : null;
      maxima.forEach((mi, k) => {
        const p = prof[mi] as { s: number; x: number; y: number; intensity: number };
        const sat = p.intensity >= params.saturationIntensity - 0.5;
        const aboveMass = (() => {
          let a = 0;
          let b = 0;
          for (let i = mi; i <= r1; i++) a += (prof[i] as { intensity: number }).intensity - bandThresh;
          for (let i = r0; i <= mi; i++) b += (prof[i] as { intensity: number }).intensity - bandThresh;
          return { down: a, up: b };
        })();
        const ratio = aboveMass.down / Math.max(aboveMass.up, 1e-9);
        const tailing = ratio > params.tailSkewRatio ? "right" : 1 / ratio > params.tailSkewRatio ? "left" : "none";
        bands.push({
          center: { x: p.x, y: p.y },
          arcS: p.s,
          widthPx: lane.halfWidth * 2,
          heightPx: ((prof[r1] as { s: number }).s - (prof[r0] as { s: number }).s) / Math.max(maxima.length, 1),
          peakIntensity: Math.round(p.intensity * 100) / 100,
          saturated: sat,
          tailing: overlap ? "none" : tailing,
          overlapGroupKey: groupKey
        });
      });
    }
    const merged: DetectedBand[] = [];
    const groupOf = new Map<number, string>();
    for (let k = 0; k < bands.length; k++) {
      const cur = bands[k]!;
      const closeTo = merged
        .map((mb, mi) => ({ mb, mi, d: Math.abs(mb.center.y - cur.center.y) }))
        .filter((x) => x.d <= params.overlapSeparationPx)
        .sort((a, b) => a.d - b.d)[0];
      if (closeTo) {
        const key = groupOf.get(closeTo.mi) ?? `ov-${lane.seedX}-${Math.round(closeTo.mb.center.y)}`;
        groupOf.set(merged.length, key);
        groupOf.set(closeTo.mi, key);
        merged.push({ ...cur, overlapGroupKey: key });
      } else {
        merged.push(cur);
      }
    }
    for (let mi = 0; mi < merged.length; mi++) {
      const key = groupOf.get(mi);
      if (key) merged[mi] = { ...(merged[mi] as DetectedBand), overlapGroupKey: key };
    }
    bandsAll.push(merged);
  }

  return { lanes, bands: bandsAll, pixelValueRange: [Math.round(minV), Math.round(maxV)] };
}
