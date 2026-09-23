import { Casepack } from "../src/domain/pipeline.ts";

export const W = 360, H = 480;
const Y0 = 30;
export const LADDER_BP = [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1000];
const LANES_X = [50, 120, 190, 260, 330];
const dOf = (mw: number) => (4.1 - Math.log10(mw)) * 160;
const smile = (x: number) => 16 * Math.pow((x - 190) / 140, 2);

/** lane boundary polyline in the NORMALIZED frame, curved per lane (smile). */
export function laneBoundary(laneIdx: number): { x: number; y: number }[] {
  const lx = LANES_X[laneIdx];
  const s = smile(lx);
  const pts: { x: number; y: number }[] = [];
  for (let y = 20; y <= 460; y += 40) pts.push({ x: lx + (s / 300) * y + 0.00002 * s * y * y, y });
  return pts;
}

export function bandNorm(laneIdx: number, mw: number): { x: number; y: number } {
  const y = Y0 + dOf(mw) + smile(LANES_X[laneIdx]);
  return { x: LANES_X[laneIdx] + (smile(LANES_X[laneIdx]) / 300) * y, y };
}

/** rotate normalized point into raw stored frame (inverse of rotatePoint with deg=90). */
export function toRaw(p: { x: number; y: number }): { x: number; y: number } {
  return { x: Math.round(H - 1 - p.y), y: Math.round(p.x) };
}

export interface BandSpec { id: string; lane: number; mw: number; intensity?: number; trailing?: number; dy?: number; }

export function makePack(opts: {
  bands?: BandSpec[];
  ladderSizes?: number[];
  orientation?: 0 | 90 | 180 | 270;
  laneCount?: number;
} = {}): Casepack {
  const laneCount = opts.laneCount ?? 5;
  const sizes = opts.ladderSizes ?? LADDER_BP;
  const specs: BandSpec[] = opts.bands ?? [
    ...sizes.map((mw, i) => ({ id: `lad-${i}`, lane: 0, mw, intensity: 210, trailing: 0.1 })),
    { id: "s1-a", lane: 1, mw: 6000, intensity: 200, trailing: 0.1 },
    { id: "s1-b", lane: 1, mw: 3000, intensity: 195, trailing: 0.2 },
    { id: "s2-sat", lane: 2, mw: 4000, intensity: 255, trailing: 0.1 },
    { id: "s2-far", lane: 2, mw: 800, intensity: 180, trailing: 0.1 },
    { id: "s3-ov1", lane: 3, mw: 3200, intensity: 190, trailing: 0.1 },
    { id: "s3-ov2", lane: 3, mw: 3060, intensity: 190, trailing: 0.1 },
    { id: "s3-trail", lane: 3, mw: 2000, intensity: 185, trailing: 0.7 },
    { id: "s4-a", lane: 4, mw: 8000, intensity: 200, trailing: 0.1 },
    { id: "s4-b", lane: 4, mw: 2000, intensity: 200, trailing: 0.1 },
  ];
  return {
    name: "fixture-gel",
    image: { file: "gel.png", width: H, height: W }, // raw stored rotated 90 deg
    capture: { orientationDeg: opts.orientation ?? 90, exposureRaw: "2.5 kV*h" },
    ladder: { laneIndex: 0, sizesRaw: sizes.map((s) => `${s} bp`) },
    lanes: Array.from({ length: laneCount }, (_, i) => ({
      id: `lane-${i}`,
      boundaryRaw: laneBoundary(i).map(toRaw),
    })),
    bands: specs.map((b) => {
      const n = bandNorm(b.lane, b.mw);
      const r = toRaw({ x: n.x, y: n.y + (b.dy ?? 0) });
      return { id: b.id, laneId: `lane-${b.lane}`, x: r.x, y: r.y, maxIntensity: b.intensity ?? 200, trailingScore: b.trailing ?? 0.1 };
    }),
    saturationThreshold: 250,
  };
}
