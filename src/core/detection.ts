import type {
  BandObservation,
  CurvePoint,
  Diagnostic,
  GaussianFit,
  LaneGeometry,
  PixelProvenance,
} from '../shared/model.js';
import type { GrayRaster } from './image.js';
import { migrationS } from './geometry.js';
import { resample, polylineLength } from './geomUtil.js';

export interface DetectionParameters {
  saturationThreshold: number;
  tailingAsymmetry: number;
  overlapSeparationPx: number;
  bandSnapping: boolean;
}

export const DEFAULT_DETECTION_PARAMETERS: DetectionParameters = {
  saturationThreshold: 8,
  tailingAsymmetry: 1.8,
  overlapSeparationPx: 14,
  bandSnapping: true,
};

export interface DetectedBand {
  bandId: string;
  laneId: string;
  center: CurvePoint;
  widthPx: number;
  height: number;
  fit: GaussianFit;
  exposure: BandObservation['exposure'];
  saturatedPixels: number;
  tailing: BandObservation['tailing'];
  overlapWith: string[];
  profile: { s: number; intensity: number; residual: number }[];
}

export interface DetectionResult {
  lanes: LaneGeometry[];
  bands: DetectedBand[];
  diagnostics: Diagnostic[];
}

const MIN_DARKNESS = 16;
const MIN_BAND_SIGMA = 2;
const MAX_BAND_SIGMA = 60;

function darknessAt(raster: GrayRaster, x: number, y: number): number {
  const xi = Math.round(x);
  const yi = Math.round(y);
  if (xi < 0 || yi < 0 || xi >= raster.width || yi >= raster.height) return 0;
  return 255 - raster.data[yi * raster.width + xi]!;
}

export function detectBandsAlongLane(
  raster: GrayRaster,
  lane: LaneGeometry,
  params: DetectionParameters,
  blobId: string,
): DetectedBand[] {
  const center = resample(lane.center, 1);
  const total = polylineLength(center);
  const halfWidth = estimateHalfWidth(lane);
  const samples: { s: number; p: CurvePoint; dark: number }[] = [];
  for (let s = 0; s <= total; s += 1) {
    const p = pointAtS(center, s);
    let darkSum = 0;
    let weightSum = 0;
    for (let off = -halfWidth; off <= halfWidth; off += 2) {
      const n = normalAtS(center, s);
      const w = 1 - Math.abs(off) / (halfWidth + 1);
      darkSum += darknessAt(raster, p.x + n.x * off, p.y + n.y * off) * w;
      weightSum += w;
    }
    samples.push({ s, p, dark: weightSum ? darkSum / weightSum : 0 });
  }
  const baseline = estimateBaseline(samples.map((z) => z.dark));
  const smoothed = movingAverage(samples.map((z) => z.dark), 3);
  const rawPeaks = findPeaks(smoothed, baseline + MIN_DARKNESS, params.overlapSeparationPx);
  const peaks = splitPlateauPeaks(rawPeaks, smoothed, baseline + MIN_DARKNESS, params.overlapSeparationPx);
  const bands: DetectedBand[] = [];
  const overlapping = new Set<number>();
  for (let pi = 0; pi < peaks.length; pi++) {
    for (let pj = pi + 1; pj < peaks.length; pj++) {
      if (Math.abs(peaks[pi]! - peaks[pj]!) <= params.overlapSeparationPx) {
        overlapping.add(pi);
        overlapping.add(pj);
      }
    }
  }
  peaks.forEach((peakIndex, k) => {
    const window = Math.round(overlapping.has(k) ? 7 : 12);
    const lo = Math.max(0, peakIndex - window);
    const hi = Math.min(samples.length - 1, peakIndex + window);
    const ys = samples.slice(lo, hi + 1).map((z) => Math.max(0, z.dark - baseline));
    const xs = samples.slice(lo, hi + 1).map((z) => z.s);
    const fit = fitGaussian(xs, ys);
    if (fit.sigma < MIN_BAND_SIGMA || fit.sigma > MAX_BAND_SIGMA || fit.amplitude < MIN_DARKNESS) return;
    if (lane.laneId==='lane-5' && fit.sigma>9) console.error('DBG sigma',fit.sigma.toFixed(1),'rms',fit.rmsResidual.toFixed(1),'res', xs.map((x,i)=>Math.round(ys[i]!-gaussianValue(x,fit))).join(','));
    const unresolved = unresolvedDoubleGaussian(xs, ys, fit, params.overlapSeparationPx);
    const fitVariants = unresolved ? [shiftedFit(fit, unresolved.delta), shiftedFit(fit, -unresolved.delta)] : [fit];
    for (const componentFit of fitVariants) {
    const muS = componentFit.mu;
    const centerPoint = pointAtS(center, muS);
    let saturatedPixels = 0;
    for (let dsx = -halfWidth; dsx <= halfWidth; dsx += 2) {
      const n = normalAtS(center, muS);
      if (darknessAt(raster, centerPoint.x + n.x * dsx, centerPoint.y + n.y * dsx) > 255 - params.saturationThreshold) {
        saturatedPixels++;
      }
    }
    const exposure: BandObservation['exposure'] =
      saturatedPixels > 2 ? 'saturated' : fit.amplitude < 22 ? 'underexposed' : 'ok';
    const tailing = detectTailing(xs, ys, fit, params.tailingAsymmetry);
    const bandId = `${lane.laneId}-b${String(bands.length + 1).padStart(2, '0')}`;
    const profile = xs.map((sv, i) => ({
      s: sv,
      intensity: ys[i]! + baseline,
      residual: ys[i]! - gaussianValue(sv, fit),
    }));
    bands.push({
      bandId,
      laneId: lane.laneId,
      center: centerPoint,
      widthPx: componentFit.sigma * 2,
      height: componentFit.amplitude,
      fit: { ...componentFit, samples: xs.length },
      exposure,
      saturatedPixels,
      tailing,
      overlapWith: [],
      profile,
    });
    }
  });
  resolveOverlapIds(bands, params.overlapSeparationPx);
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      const sep = Math.abs(bands[i]!.fit.mu - bands[j]!.fit.mu);
      if (sep < params.overlapSeparationPx) {
        bands[i]!.overlapWith.push(bands[j]!.bandId);
        bands[j]!.overlapWith.push(bands[i]!.bandId);
      }
    }
  }
  return bands;
}

function estimateHalfWidth(lane: LaneGeometry): number {
  let total = 0;
  for (let i = 0; i < lane.center.length; i += Math.max(1, Math.floor(lane.center.length / 8))) {
    const c = lane.center[i]!;
    const l = lane.left[Math.min(i, lane.left.length - 1)] ?? lane.left[lane.left.length - 1]!;
    const r = lane.right[Math.min(i, lane.right.length - 1)] ?? lane.right[lane.right.length - 1]!;
    total += Math.hypot(l.x - c.x, l.y - c.y) + Math.hypot(r.x - c.x, r.y - c.y);
  }
  return Math.max(2, Math.round((total / 9) * 0.8));
}

function pointAtS(points: CurvePoint[], s: number): CurvePoint {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + seg >= s) {
      const t = seg === 0 ? 0 : (s - acc) / seg;
      return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    }
    acc += seg;
  }
  return { ...points[points.length - 1]! };
}

function normalAtS(points: CurvePoint[], s: number): CurvePoint {
  let acc = 0;
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    const seg = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + seg >= s) {
      const n = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      return { x: -(b.y - a.y) / n, y: (b.x - a.x) / n };
    }
    acc += seg;
  }
  const a = points[points.length - 2]!;
  const b = points[points.length - 1]!;
  const n = Math.hypot(b.x - a.x, b.y - a.y) || 1;
  return { x: -(b.y - a.y) / n, y: (b.x - a.x) / n };
}

function estimateBaseline(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length * 0.2)] ?? 0;
}

function movingAverage(values: number[], radius: number): number[] {
  return values.map((_, i) => {
    let sum = 0;
    let count = 0;
    for (let k = Math.max(0, i - radius); k <= Math.min(values.length - 1, i + radius); k++) {
      sum += values[k]!;
      count++;
    }
    return sum / count;
  });
}

function splitPlateauPeaks(peaks: number[], values: number[], threshold: number, overlapSeparationPx: number): number[] {
  const out: number[] = [];
  for (const peak of peaks) {
    const summit = values[peak]!;
    const summitFloor = Math.max(threshold, summit * 0.95);
    let left = peak;
    let right = peak;
    while (left - 1 >= 0 && values[left - 1]! >= summitFloor) left--;
    while (right + 1 < values.length && values[right + 1]! >= summitFloor) right++;
    const width = right - left;
    if (width >= 9 && width <= overlapSeparationPx + 1) {
      const first = Math.round(left + width * 0.3);
      const second = Math.round(right - width * 0.3);
      if (second - first >= 6) {
        out.push(first, second);
        continue;
      }
    }
    out.push(peak);
  }
  const deduped = out.filter((idx, i) => i === 0 || idx - out[i - 1]! >= 4);
  return deduped.sort((a, b) => a - b);
}

function findPeaks(values: number[], threshold: number, overlapSeparationPx: number): number[] {
  const candidates: { index: number; value: number }[] = [];
  for (let i = 2; i < values.length - 2; i++) {
    const localMax = values[i]! >= values[i - 1]! && values[i]! >= values[i + 1]!;
    const shoulder =
      values[i]! >= threshold &&
      values[i]! - values[i - 1]! > 0 &&
      values[i]! - values[i + 1]! >= 0 &&
      values[i]! - values[i + 2]! > -6 &&
      values[i]! - values[i - 2]! > 6;
    if (values[i]! >= threshold && (localMax || shoulder)) {
      candidates.push({ index: i, value: values[i]! });
    }
  }
  const peaks: number[] = [];
  for (const candidate of candidates.sort((a, b) => b.value - a.value)) {
    if (peaks.every((idx) => Math.abs(idx - candidate.index) >= 5)) peaks.push(candidate.index);
  }
  void overlapSeparationPx;
  return peaks.sort((a, b) => a - b);
}

function gaussianValue(x: number, fit: Pick<GaussianFit, 'amplitude' | 'mu' | 'sigma'>): number {
  return fit.amplitude * Math.exp(-((x - fit.mu) ** 2) / (2 * fit.sigma ** 2));
}

function fitGaussian(xs: number[], ys: number[]): GaussianFit {
  const peakIndex = ys.reduce((best, y, i) => (y > ys[best]! ? i : best), 0);
  let amplitude = Math.max(1, ys[peakIndex]!);
  let mu = xs[peakIndex]!;
  let sigma = 6;
  let weighted = 0;
  let total = 0;
  for (let i = 0; i < xs.length; i++) {
    const y = ys[i]!;
    if (y > amplitude * 0.2) {
      weighted += Math.abs(xs[i]! - mu) * y;
      total += y;
    }
  }
  sigma = total ? Math.max(1.5, (weighted / total) * 1.25) : 6;
  let previousRms = Infinity;
  for (let iter = 0; iter < 80; iter++) {
    let gMu = 0;
    let gSig = 0;
    let gAmp = 0;
    let hMu = 0;
    let hSig = 0;
    let hAmp = 0;
    let sumSq = 0;
    for (let i = 0; i < xs.length; i++) {
      const x = xs[i]!;
      const y = ys[i]!;
      const g = amplitude * Math.exp(-((x - mu) ** 2) / (2 * sigma * sigma));
      const residual = g - y;
      sumSq += residual * residual;
      const dMu = g * ((x - mu) / (sigma * sigma));
      const dSig = g * ((x - mu) ** 2 / (sigma ** 3));
      const dAmp = g / Math.max(amplitude, 1e-6);
      gMu += residual * dMu;
      gSig += residual * dSig;
      gAmp += residual * dAmp;
      hMu += dMu * dMu;
      hSig += dSig * dSig;
      hAmp += dAmp * dAmp;
    }
    const stepMu = hMu ? gMu / hMu : 0;
    const stepSig = hSig ? gSig / hSig : 0;
    const stepAmp = hAmp ? gAmp / hAmp : 0;
    mu = Math.max(xs[0]!, Math.min(xs[xs.length - 1]!, mu - stepMu));
    sigma = Math.max(1.2, Math.min(90, sigma - stepSig));
    amplitude = Math.max(1, amplitude - stepAmp);
    const rms = Math.sqrt(sumSq / xs.length);
    if (Math.abs(previousRms - rms) < 1e-4) break;
    previousRms = rms;
  }
  return { baseline: 0, amplitude, mu, sigma, rmsResidual: previousRms === Infinity ? 0 : previousRms, samples: xs.length };
}

function rmsResidual(xs: number[], ys: number[], fit: Pick<GaussianFit, 'amplitude' | 'mu' | 'sigma'>): number {
  let sum = 0;
  for (let i = 0; i < xs.length; i++) {
    const r = gaussianValue(xs[i]!, fit) - ys[i]!;
    sum += r * r;
  }
  return Math.sqrt(sum / Math.max(1, xs.length));
}

function detectTailing(xs: number[], ys: number[], fit: GaussianFit, threshold: number): BandObservation['tailing'] {
  let left = 0;
  let right = 0;
  for (let i = 0; i < xs.length; i++) {
    const x = xs[i]!;
    const residual = ys[i]! - gaussianValue(x, fit);
    if (residual > fit.rmsResidual * 1.6) {
      if (x < fit.mu) left += residual;
      else right += residual;
    }
  }
  const larger = Math.max(left, right);
  const smaller = Math.min(left, right);
  const signal = Math.max(0, larger - smaller);
  if (signal < fit.amplitude * 4 || larger < fit.amplitude * 3) return 'none';
  if (larger / Math.max(smaller, 1e-6) >= threshold) return right > left ? 'right' : 'left';
  return 'none';
}

export function provenance(blobId: string, x: number, y: number, precisionPx = 1): PixelProvenance {
  return { blobId, frame: 'original-pixels', x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10, precisionPx };
}

export function toObservation(band: DetectedBand, blobId: string): BandObservation {
  return {
    bandId: band.bandId,
    laneId: band.laneId,
    center: band.center,
    widthPx: band.widthPx,
    height: band.height,
    fit: band.fit,
    exposure: band.exposure,
    saturatedPixels: band.saturatedPixels,
    tailing: band.tailing,
    overlapWith: band.overlapWith.length ? band.overlapWith : undefined,
    source: provenance(blobId, band.center.x, band.center.y),
  };
}

export function bandProfile(band: DetectedBand) {
  return band.profile;
}

export function migrationAlongLane(lane: LaneGeometry, point: CurvePoint) {
  return migrationS(lane, point);
}


function shiftedFit(fit: GaussianFit, delta: number): GaussianFit {
  return { ...fit, mu: fit.mu + delta, sigma: Math.min(fit.sigma, 7), amplitude: fit.amplitude * 0.92 };
}

function unresolvedDoubleGaussian(
  xs: number[],
  ys: number[],
  fit: GaussianFit,
  overlapSeparationPx: number,
): { delta: number } | null {
  if (fit.sigma < 9) return null;
  const residuals = xs.map((x, i) => ({ x, r: ys[i]! - gaussianValue(x, fit) }));
  const positive = residuals.filter((z) => z.r > fit.rmsResidual * 1.5);
  if (positive.length < 4) return null;
  let leftX: number | null = null;
  let rightX: number | null = null;
  for (const z of positive) {
    if (z.x < fit.mu) leftX = z.x;
    if (z.x > fit.mu) rightX = z.x;
  }
  if (leftX === null || rightX === null) return null;
  const delta = (rightX - leftX) / 2;
  if (delta < 4 || delta > overlapSeparationPx) return null;
  return { delta };
}

function resolveOverlapIds(bands: DetectedBand[], overlapSeparationPx: number): void {
  for (const band of bands) band.overlapWith = [];
  for (let i = 0; i < bands.length; i++) {
    for (let j = i + 1; j < bands.length; j++) {
      if (bands[i]!.laneId !== bands[j]!.laneId) continue;
      if (Math.abs(bands[i]!.fit.mu - bands[j]!.fit.mu) <= overlapSeparationPx) {
        bands[i]!.overlapWith.push(bands[j]!.bandId);
        bands[j]!.overlapWith.push(bands[i]!.bandId);
      }
    }
  }
}
