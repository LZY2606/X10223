import { BlobSpec, GelSpec, CASE_SMILE, mwToY, renderGel, rotate90cw, rotatePoint90cw } from './gelimage.js';
import { LaneCurve, smileOffset } from '../shared/lanes.js';
import { GrayImage } from '../shared/detect.js';

/**
 * Offline domain case pack: "胶道标尺" — a synthetic but realistic gel with
 * ladder, 4 sample lanes, smile curvature, a bent lane, a saturated band,
 * an overlapping pair, a trailing band and an out-of-range band.
 * Everything is deterministic so the archive is byte-stable.
 */

export const CASE = {
  imageId: 'gel-base',
  width: 360,
  height: 460,
  smile: CASE_SMILE,
  ladderTop: 60,
  logTop: 4, // log10(10000)
  pxPerLog: 261.5,
  laneHalfWidth: 8,
} as const;

export interface LaneDef {
  laneId: string;
  x: number;
  bend: number; // sinusoidal bend amplitude px
}

export const LANES: LaneDef[] = [
  { laneId: 'ladder', x: 60, bend: 0 },
  { laneId: 'lane1', x: 120, bend: 0 },
  { laneId: 'lane2', x: 180, bend: 0 },
  { laneId: 'lane3', x: 240, bend: 0 },
  { laneId: 'lane4', x: 300, bend: 10 },
];

/** nominal ladder: evenly spaced in log10 so baseline spacing is uniform */
export const LADDER_NOMINAL: { mw: number; raw: string }[] = [
  { mw: 10000, raw: '10 kb' },
  { mw: 6300, raw: '6.3 kb' },
  { mw: 4000, raw: '4 kb' },
  { mw: 2500, raw: '2.5 kb' },
  { mw: 1600, raw: '1.6 kb' },
  { mw: 1000, raw: '1 kb' },
  { mw: 630, raw: '630 bp' },
  { mw: 400, raw: '400 bp' },
];

/** extra faint ladder band whose nominal cannot be converted: stays raw + diagnostic */
export const UNKNOWN_BAND_Y = 98;

export function analysisY(mw: number): number {
  return mwToY(mw, CASE.ladderTop, CASE.logTop, CASE.pxPerLog);
}

export function centerlineX(lane: LaneDef, y: number): number {
  return lane.x + lane.bend * Math.sin(((y - 40) / 415) * Math.PI);
}

export function laneCurveOf(lane: LaneDef, imageId: string): LaneCurve {
  const centerline = [];
  for (let y = 40; y <= 455; y += 41.5) {
    centerline.push({ x: centerlineX(lane, y), y, space: 'image-px' as const, imageId });
  }
  return { laneId: lane.laneId, imageId, centerline, halfWidth: CASE.laneHalfWidth };
}

export interface SampleBand {
  laneId: string;
  mw: number;
  amplitude: number;
  tail?: { amplitude: number; sigmaY: number };
}

export const SAMPLE_BANDS: SampleBand[] = [
  { laneId: 'lane1', mw: 6000, amplitude: 200 },
  { laneId: 'lane1', mw: 3000, amplitude: 200 },
  { laneId: 'lane1', mw: 1000, amplitude: 200 },
  { laneId: 'lane2', mw: 5000, amplitude: 200 },
  { laneId: 'lane2', mw: 4000, amplitude: 600 }, // saturates
  { laneId: 'lane2', mw: 1500, amplitude: 200 },
  { laneId: 'lane3', mw: 3050, amplitude: 240 }, // overlaps with 2950
  { laneId: 'lane3', mw: 2950, amplitude: 240 },
  { laneId: 'lane3', mw: 1000, amplitude: 200 },
  { laneId: 'lane4', mw: 2000, amplitude: 140, tail: { amplitude: 105, sigmaY: 14 } }, // trailing
  { laneId: 'lane4', mw: 800, amplitude: 200 },
  { laneId: 'lane4', mw: 350, amplitude: 180 }, // below ladder range -> out of valid region
];

export function bandImageY(lane: LaneDef, mw: number): number {
  return analysisY(mw) + smileOffset(CASE.smile, lane.x);
}

export function buildGelSpec(overrides: { saturateLane2FirstBand?: boolean } = {}): GelSpec {
  const blobs: BlobSpec[] = [];
  for (const { mw } of LADDER_NOMINAL) {
    blobs.push({ cx: 60, cy: bandImageY(LANES[0]!, mw), amplitude: 180, sigmaX: 5, sigmaY: 2.2 });
  }
  blobs.push({ cx: 60, cy: UNKNOWN_BAND_Y, amplitude: 120, sigmaX: 5, sigmaY: 2 });
  for (const b of SAMPLE_BANDS) {
    const lane = LANES.find((l) => l.laneId === b.laneId)!;
    const cy = bandImageY(lane, b.mw);
    let amplitude = b.amplitude;
    if (overrides.saturateLane2FirstBand && b.laneId === 'lane2' && b.mw === 5000) amplitude = 700;
    blobs.push({ cx: centerlineX(lane, cy), cy, amplitude, sigmaX: 5, sigmaY: 2.2, tail: b.tail });
  }
  return { width: CASE.width, height: CASE.height, background: 30, noise: 8, seed: 20260919, blobs };
}

export function renderBaseImage(overrides: { saturateLane2FirstBand?: boolean } = {}): GrayImage {
  return renderGel(buildGelSpec(overrides));
}

export function renderRotatedImage(): { rotated: GrayImage; original: GrayImage } {
  const original = renderBaseImage();
  return { rotated: rotate90cw(original), original };
}

export { rotatePoint90cw };
