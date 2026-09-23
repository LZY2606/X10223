import type { CurvePoint } from '../shared/model.js';
import type { GrayRaster } from './image.js';
import { resample, polylineLength, pointAlong } from './geomUtil.js';

export interface SyntheticBandSpec {
  id: string;
  laneIndex: number;
  sFraction: number;
  sigmaTangential: number;
  sigmaMigration: number;
  darkness: number;
  saturated?: boolean;
  tailing?: { side: 'down' | 'up'; factor: number };
}

export interface SyntheticLaneSpec {
  id: string;
  label: string;
  center: CurvePoint[];
  halfWidth: number;
  wellSide: 'top' | 'bottom';
}

export interface SyntheticGelSpec {
  width: number;
  height: number;
  lanes: SyntheticLaneSpec[];
  bands: SyntheticBandSpec[];
  noise?: number;
  seed?: number;
}

function mulberry32(seed: number) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function renderSyntheticGel(spec: SyntheticGelSpec): GrayRaster {
  const { width, height, lanes, bands } = spec;
  const rng = mulberry32(spec.seed ?? 1194);
  const noise = spec.noise ?? 6;
  const data = new Uint8Array(width * height);
  const resampled = lanes.map((lane) => ({
    spec: lane,
    points: resample(lane.center, 2),
    length: 0,
  }));
  for (const r of resampled) r.length = polylineLength(r.points);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let intensity = 232;
      for (let li = 0; li < resampled.length; li++) {
        const lane = resampled[li]!;
        const near = nearestOnCurve(lane.points, { x, y });
        const halfWidth = lanes[li]!.halfWidth;
        if (near.distance > halfWidth + 3 * 3) continue;
        const crossFactor = Math.exp(-(near.distance ** 2) / (2 * (halfWidth * 0.62) ** 2));
        let laneDark = 0;
        const sFrac = near.s / lane.length;
        for (const band of bands) {
          if (band.laneIndex !== li) continue;
          const ds = sFrac - band.sFraction;
          const sigmaS = band.sigmaMigration / lane.length;
          let sigma = sigmaS;
          if (band.tailing) {
            const downstream = band.tailing.side === 'down' ? ds > 0 : ds < 0;
            if (downstream) sigma = sigmaS * band.tailing.factor;
          }
          const axial = Math.exp(-(ds ** 2) / (2 * sigma * sigma));
          laneDark += band.darkness * axial * crossFactor;
        }
        laneDark = Math.min(170, laneDark);
        if (laneDark > 0) {
          intensity -= laneDark * crossFactor + 4 * crossFactor;
        }
      }
      let v = intensity + (rng() - 0.5) * noise;
      v = Math.round(Math.max(0, Math.min(255, v)));
      const saturatedBand = bands.some((b) => {
        if (!b.saturated) return false;
        const lane = resampled[b.laneIndex]!;
        const near = nearestOnCurve(lane.points, { x, y });
        if (near.distance > lanes[b.laneIndex]!.halfWidth) return false;
        const sFrac = near.s / lane.length;
        const sigmaS = b.sigmaMigration / lane.length;
        return Math.abs(sFrac - b.sFraction) < sigmaS * 0.9 && near.distance < lanes[b.laneIndex]!.halfWidth * 0.55;
      });
      if (saturatedBand) v = 0;
      data[y * width + x] = v;
    }
  }
  return { width, height, data };
}

function nearestOnCurve(points: CurvePoint[], p: CurvePoint): { distance: number; s: number } {
  let best = Infinity;
  let bestS = 0;
  let s = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const segLen2 = abx * abx + aby * aby || 1e-9;
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / segLen2;
    t = Math.max(0, Math.min(1, t));
    const px = a.x + abx * t;
    const py = a.y + aby * t;
    const d = Math.hypot(p.x - px, p.y - py);
    if (d < best) {
      best = d;
      bestS = s + Math.hypot(px - a.x, py - a.y);
    }
    s += Math.hypot(abx, aby);
  }
  return { distance: best, s: bestS };
}

export function straightLanes(
  width: number,
  yTop: number,
  yBottom: number,
  xs: number[],
  halfWidth: number,
): SyntheticLaneSpec[] {
  return xs.map((x, i) => ({
    id: `lane-${i + 1}`,
    label: i === 0 ? 'Ladder' : `Sample ${i}`,
    center: [
      { x, y: yTop },
      { x, y: yBottom },
    ],
    halfWidth,
    wellSide: 'top',
  }));
}

export function smilingLanes(
  yTop: number,
  yBottom: number,
  xs: number[],
  halfWidth: number,
  amp: number,
): SyntheticLaneSpec[] {
  return xs.map((x, i) => {
    const shift = amp * (i / (xs.length - 1));
    const points: CurvePoint[] = [];
    for (let k = 0; k <= 20; k++) {
      const t = k / 20;
      const y = yTop + (yBottom - yTop) * t;
      const bow = shift * Math.sin(Math.PI * t);
      points.push({ x: x + bow, y });
    }
    return {
      id: `lane-${i + 1}`,
      label: i === 0 ? 'Ladder' : `Sample ${i}`,
      center: points,
      halfWidth,
      wellSide: 'top',
    };
  });
}

export function bandCenterPoint(lane: SyntheticLaneSpec, sFraction: number): CurvePoint {
  const s = sFraction * polylineLength(resample(lane.center, 2));
  return pointAlong(resample(lane.center, 2), s);
}
