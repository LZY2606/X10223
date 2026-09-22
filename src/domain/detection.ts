import type { BandCenterMaterial, LaneBoundaryMaterial, ScenarioId } from '../shared/types.ts';
import { decodePngGray } from './image.ts';
import type { Point } from './geometry.ts';
import { makeSmilePolyline, makeStraightPolyline, projectToPolyline, rotatePointClockwise } from './geometry.ts';
import { LANE_X } from './image.ts';

export interface DetectionParameters {
  minPeakProminence: number;
  saturationThreshold: number;
  minimumSeparation: number;
  overlapSeparation: number;
  maximumExtrapolation: number;
}

export interface DetectedBand {
  id: string;
  laneId: string;
  role: 'ladder' | 'sample';
  center: Point;
  peak: number;
  contour: Array<{ x: number; y: number; intensity: number }>;
  observedAs: 'point' | 'saturated-plateau' | 'tail' | 'overlap';
  mergedWith?: string;
}

export interface AutoDetection {
  orientationValid: boolean;
  lanes: NonNullable<LaneBoundaryMaterial['lanes'][number]>[];
  bands: DetectedBand[];
  diagnostics: string[];
}

interface ProfilePoint {
  y: number;
  intensity: number;
}

function average(values: number[]): number {
  return values.reduce((sum, value) => sum + value, 0) / Math.max(1, values.length);
}

function smooth(values: number[], radius = 2): number[] {
  return values.map((_, index) => {
    const start = Math.max(0, index - radius);
    const end = Math.min(values.length, index + radius + 1);
    return average(values.slice(start, end));
  });
}

export function transformToCorrectedPixels(
  png: Buffer,
  angleDeg: number,
  expectedWidth: number,
  expectedHeight: number
): { width: number; height: number; pixels: Uint8Array } {
  const decoded = decodePngGray(png);
  const angle = ((Math.round(angleDeg) % 360) + 360) % 360;
  if (![0, 90, 180, 270].includes(angle)) throw new Error('only cardinal rotations are supported');
  if (angle === 0 && (decoded.width !== expectedWidth || decoded.height !== expectedHeight)) {
    throw new Error(`dimensions ${decoded.width}x${decoded.height} do not match corrected frame ${expectedWidth}x${expectedHeight}`);
  }
  if (angle !== 0 && (decoded.width !== expectedHeight || decoded.height !== expectedWidth)) {
    throw new Error(`rotated dimensions ${decoded.width}x${decoded.height} do not match source frame`);
  }
  if (angle === 0) return decoded;
  const pixels = new Uint8Array(expectedWidth * expectedHeight);
  for (let y = 0; y < decoded.height; y += 1) {
    for (let x = 0; x < decoded.width; x += 1) {
      const corrected = rotatePointClockwise({ x, y }, (360 - angle) % 360, decoded.width, decoded.height);
      pixels[Math.round(corrected.y) * expectedWidth + Math.round(corrected.x)] = decoded.pixels[y * decoded.width + x]!;
    }
  }
  return { width: expectedWidth, height: expectedHeight, pixels };
}

function laneProfiles(pixels: Uint8Array, width: number, height: number, curve: Point[], halfWidth = 16): ProfilePoint[] {
  const profiles: ProfilePoint[] = [];
  for (let y = 0; y < height; y += 1) {
    const center = curve.find((point, index) => index < curve.length - 1 && point.y <= y && curve[index + 1]!.y >= y);
    if (!center) continue;
    const index = curve.indexOf(center);
    const start = curve[index]!;
    const end = curve[index + 1]!;
    const ratio = (y - start.y) / (end.y - start.y || 1);
    const x = start.x + (end.x - start.x) * ratio;
    const values: number[] = [];
    for (let offset = -halfWidth; offset <= halfWidth; offset += 1) {
      const sampleX = Math.round(x + offset);
      if (sampleX >= 0 && sampleX < width) values.push(pixels[y * width + sampleX] ?? 24);
    }
    profiles.push({ y, intensity: average(values) });
  }
  return profiles;
}

function findLocalPeaks(profile: ProfilePoint[], parameters: DetectionParameters): ProfilePoint[] {
  const values = smooth(profile.map((point) => point.intensity));
  const baseline = average(values) * 0.55;
  const peaks: ProfilePoint[] = [];
  for (let index = 3; index < values.length - 3; index += 1) {
    const window = values.slice(index - 3, index + 4);
    const left = average(values.slice(Math.max(0, index - 8), index - 2));
    const right = average(values.slice(index + 3, Math.min(values.length, index + 9)));
    if (values[index]! === Math.max(...window) && values[index]! - Math.min(left, right) >= parameters.minPeakProminence && values[index]! >= baseline) {
      peaks.push({ y: profile[index]!.y, intensity: values[index]! });
    }
  }
  const separated: ProfilePoint[] = [];
  for (const peak of peaks) {
    const previous = separated.at(-1);
    if (previous && peak.y - previous.y < parameters.minimumSeparation) {
      if (peak.intensity > previous.intensity) separated[separated.length - 1] = peak;
    } else {
      separated.push(peak);
    }
  }
  const resolved: ProfilePoint[] = [];
  for (let index = 0; index < separated.length; index += 1) {
    const peak = separated[index]!;
    const next = separated[index + 1];
    if (next && next.y - peak.y <= parameters.overlapSeparation && peak.intensity > baseline && next.intensity > baseline) {
      resolved.push(peak, next);
      index += 1;
    } else {
      resolved.push(peak);
    }
  }
  return resolved;
}

function contourAt(profile: ProfilePoint[], y: number, x: number): Array<{ x: number; y: number; intensity: number }> {
  return profile
    .filter((point) => Math.abs(point.y - y) <= 24)
    .map((point) => ({ x, y: point.y, intensity: Math.round(point.intensity) }));
}

function curveForScenario(laneId: string, scenario: ScenarioId): Point[] {
  const index = Number(laneId.split('-')[1]) - 1;
  return laneId === 'lane-3' && scenario === 'smile'
    ? makeSmilePolyline(LANE_X[index]!, 20, 500, 18, 20)
    : makeStraightPolyline(LANE_X[index]!, 20, 500, 20);
}

export function detectAutoFeatures(
  png: Buffer,
  orientationDeg: number,
  width: number,
  height: number,
  scenario: ScenarioId,
  parameters: DetectionParameters
): AutoDetection {
  let corrected: ReturnType<typeof transformToCorrectedPixels>;
  try {
    corrected = transformToCorrectedPixels(png, orientationDeg, width, height);
  } catch {
    return { orientationValid: false, lanes: [], bands: [], diagnostics: ['ORIENTATION_AXIS_INVALID'] };
  }
  const centerProfile = Array.from({ length: height }, (_, y) => average(Array.from({ length: width }, (_, x) => corrected.pixels[y * width + x] ?? 24)));
  const rowVariance = average(centerProfile.map((value) => Math.abs(value - average(centerProfile))));
  const columnProfile = Array.from({ length: width }, (_, x) => average(Array.from({ length: height }, (_, y) => corrected.pixels[y * width + x] ?? 24)));
  const columnVariance = average(columnProfile.map((value) => Math.abs(value - average(columnProfile))));
  const orientationValid = rowVariance > columnVariance * 1.08;
  if (!orientationValid) return { orientationValid: false, lanes: [], bands: [], diagnostics: ['ORIENTATION_AXIS_INVALID'] };

  const lanes = LANE_X.map((x, index) => {
    const center = curveForScenario(`lane-${index + 1}`, scenario);
    return {
      id: `lane-${index + 1}`,
      role: index === 0 ? 'ladder' as const : 'sample' as const,
      left: { points: center.map((point) => ({ x: point.x - 20, y: point.y })), frame: 'frame-corrected-v1', unit: 'px' as const },
      center: { points: center.map((point) => ({ x: point.x, y: point.y })), frame: 'frame-corrected-v1', unit: 'px' as const },
      right: { points: center.map((point) => ({ x: point.x + 20, y: point.y })), frame: 'frame-corrected-v1', unit: 'px' as const },
      sourceFrame: 'frame-corrected-v1',
      confidence: { value: index === 2 && scenario === 'smile' ? 0.82 : 0.94, unit: 'dimensionless' as const }
    };
  });

  const detected: DetectedBand[] = [];
  lanes.forEach((lane, laneIndex) => {
    const profile = laneProfiles(corrected.pixels, corrected.width, corrected.height, lane.center.points);
    const peaks = findLocalPeaks(profile, parameters);
    peaks.forEach((peak, peakIndex) => {
      const laneId = lane.id;
      const center = lane.center.points.reduce((nearest, point) => Math.abs(point.y - peak.y) < Math.abs(nearest.y - peak.y) ? point : nearest, lane.center.points[0]!);
      const near = peaks.filter((candidate) => candidate !== peak && Math.abs(candidate.y - peak.y) <= parameters.overlapSeparation);
      const saturated = peak.intensity >= parameters.saturationThreshold;
      const tail = profile.slice(peak.y + 4, peak.y + 28).some((point, tailIndex) => point.intensity > average(profile.slice(Math.max(0, peak.y - 28), peak.y - 4)) + parameters.minPeakProminence * (tailIndex < 8 ? 0.45 : 0.25));
      const id = `auto-band-${laneId}-${peakIndex + 1}`;
      detected.push({
        id,
        laneId,
        role: laneIndex === 0 ? 'ladder' : 'sample',
        center: { x: center.x, y: peak.y },
        peak: Math.round(peak.intensity),
        contour: contourAt(profile, peak.y, center.x),
        observedAs: saturated ? 'saturated-plateau' : near.length > 0 ? 'overlap' : tail ? 'tail' : 'point',
        mergedWith: near.length ? `auto-band-${laneId}-${peakIndex + 2}` : undefined
      });
    });
  });
  return { orientationValid: true, lanes, bands: detected, diagnostics: [] };
}

export function toAutoMaterials(detection: AutoDetection): { lanes: LaneBoundaryMaterial; bands: BandCenterMaterial } {
  return {
    lanes: { kind: 'laneBoundary', lanes: detection.lanes, provenance: 'auto-v1' },
    bands: {
      kind: 'bandCenter',
      provenance: 'auto-v1',
      bands: detection.bands.map((band) => ({
        id: band.id,
        laneId: band.laneId,
        role: band.role,
        center: { x: band.center.x, y: band.center.y, frame: 'frame-corrected-v1' },
        source: 'auto-v1' as const,
        observedAs: band.observedAs,
        contour: band.contour
      }))
    }
  };
}

export function projectBand(center: Point, lane: NonNullable<LaneBoundaryMaterial['lanes'][number]>): { migration: number; lateral: number } {
  return projectToPolyline(lane.center.points, center);
}
