import { encodeGrayPng } from './png.js';
import type {
  BandCenterMaterial,
  BandSpec,
  GelImageMaterial,
  LadderNominalMaterial,
  LaneBoundaryMaterial,
  LaneSpec,
  Material,
  PixelPoint,
  Transform
} from '../shared/types.js';

export const CASE_ID = 'case-gel-smile-001';
export const W = 420;
export const H = 320;
export const LANE_X = [60, 140, 220, 300];
export const LANE_IDS = ['lane-ladder', 'lane-1', 'lane-2', 'lane-3'];
export const LADDER_BP = [20000, 15000, 10000, 7500, 5000, 3000, 2000, 1500, 1000, 500];

export interface GelVariant {
  rotate: boolean;
  smileK: number;
  weaveAmp: number;
  omitLadderIndex?: number;
  saturated?: { lane: number; band: number };
  tailing?: { lane: number; band: number };
  overlapBands?: { lane: number; arcBpSizes: [number, number] };
  swapLadder?: [number, number];
  missingOrientation?: boolean;
}

export const BASELINE_VARIANT: GelVariant = {
  rotate: false,
  smileK: 14,
  weaveAmp: 2.5,
  saturated: { lane: 3, band: 1 },
  tailing: { lane: 3, band: 2 }
};

const S_TOP = 30;
const S_SCALE = 165;
const arcForBp = (bp: number) => S_TOP + (Math.log10(LADDER_BP[0]) - Math.log10(bp)) * S_SCALE;

function bowOffset(xc: number, k: number) {
  const nx = (xc - W / 2) / (W / 2);
  return k * nx * nx;
}

// 生成泳道弯曲中心线（参数为沿曲线弧长 s 的密集点）
export function laneCenterline(xc: number, v: GelVariant): PixelPoint[] {
  const pts: PixelPoint[] = [];
  const N = 80;
  let px = xc;
  let py = S_TOP + bowOffset(xc, v.smileK);
  pts.push({ x: px, y: py, pixelSource: { x: px, y: py, confidence: 1 } });
  let s = 0;
  for (let i = 1; i <= N; i++) {
    const sTarget = (i / N) * (arcForBp(LADDER_BP[LADDER_BP.length - 1]) - S_TOP) + S_TOP;
    const yy = S_TOP + (sTarget - S_TOP) + bowOffset(xc, v.smileK);
    const xx = xc + v.weaveAmp * Math.sin(((sTarget - S_TOP) / 270) * Math.PI);
    s += Math.hypot(xx - px, yy - py);
    px = xx;
    py = yy;
    pts.push({ x: px, y: py, pixelSource: { x: px, y: py, confidence: 1 } });
    void s;
  }
  return pts;
}

function pointAtArc(points: PixelPoint[], targetArc: number): { x: number; y: number } {
  let acc = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const segLen = Math.hypot(points[i + 1].x - points[i].x, points[i + 1].y - points[i].y);
    if (acc + segLen >= targetArc) {
      const frac = segLen === 0 ? 0 : (targetArc - acc) / segLen;
      return {
        x: points[i].x + frac * (points[i + 1].x - points[i].x),
        y: points[i].y + frac * (points[i + 1].y - points[i].y)
      };
    }
    acc += segLen;
  }
  return points[points.length - 1];
}

const SAMPLE_BANDS: Record<number, { bp: number; halfWidth: number }[]> = {
  1: [
    { bp: 9000, halfWidth: 4 },
    { bp: 3200, halfWidth: 4 },
    { bp: 1300, halfWidth: 4 }
  ],
  2: [
    { bp: 6500, halfWidth: 4 },
    { bp: 4200, halfWidth: 4 },
    { bp: 2600, halfWidth: 4 }
  ],
  3: [
    { bp: 7000, halfWidth: 4 },
    { bp: 3600, halfWidth: 4 },
    { bp: 1100, halfWidth: 4 }
  ]
};

export interface GeneratedGel {
  png: Buffer;
  width: number;
  height: number;
  lanes: { laneId: string; role: 'ladder' | 'sample'; name: string; centerline: PixelPoint[] }[];
  bands: Record<string, BandSpec[]>;
}

export function generateGel(v: GelVariant): GeneratedGel {
  const lanes: GeneratedGel['lanes'] = LANE_IDS.map((laneId, i) => ({
    laneId,
    role: i === 0 ? 'ladder' : 'sample',
    name: i === 0 ? 'Ladder' : `Sample ${i}`,
    centerline: laneCenterline(LANE_X[i], v)
  }));

  const pixels = new Uint8Array(W * H).fill(28);
  const bands: Record<string, BandSpec[]> = {};

  const blob = (cx: number, cy: number, peak: number, sigma: number, tailStretch: number, flatTop: boolean) => {
    const r = Math.ceil(sigma * 3) + 2;
    for (let y = Math.max(0, Math.floor(cy - r * tailStretch)); y < Math.min(H, Math.ceil(cy + r)); y++) {
      for (let x = Math.max(0, Math.floor(cx - r)); x < Math.min(W, Math.ceil(cx + r)); x++) {
        const dx = (x - cx) / sigma;
        const dy = y > cy ? (y - cy) / (sigma * tailStretch) : (y - cy) / sigma;
        let val = 28 + peak * Math.exp(-0.5 * (dx * dx + dy * dy));
        if (flatTop && val > 252) val = 255;
        pixels[y * W + x] = Math.min(255, Math.max(28, Math.round(val)));
      }
    }
  };

  // ladder rungs
  const ladderBandList: BandSpec[] = [];
  LADDER_BP.forEach((bp, i) => {
    if (v.omitLadderIndex === i) return;
    const p = pointAtArc(lanes[0].centerline, arcForBp(bp));
    let y = p.y;
    if (v.swapLadder && (i === v.swapLadder[0] || i === v.swapLadder[1])) {
      const other = i === v.swapLadder[0] ? v.swapLadder[1] : v.swapLadder[0];
      y = pointAtArc(lanes[0].centerline, arcForBp(LADDER_BP[other])).y;
    }
    blob(p.x, y, 182, 4, 1, false);
    ladderBandList.push({
      bandIndex: i,
      x: Math.round(p.x * 10) / 10,
      y: Math.round(y * 10) / 10,
      pixelSource: { x: Math.round(p.x), y: Math.round(y) },
      intensity: 210,
      saturated: false,
      tailing: false,
      halfWidthPx: 4
    });
  });
  bands[LANE_IDS[0]] = ladderBandList;

  for (let li = 1; li <= 3; li++) {
    const list: BandSpec[] = [];
    const defs = SAMPLE_BANDS[li].map((d, band) => ({ ...d, band }));
    if (v.overlapBands && v.overlapBands.lane === li) {
      const [bpA, bpB] = v.overlapBands.arcBpSizes;
      defs.push({ bp: bpA, halfWidth: 4, band: defs.length });
      defs.push({ bp: bpB, halfWidth: 4, band: defs.length });
    }
    for (const d of defs) {
      const p = pointAtArc(lanes[li].centerline, arcForBp(d.bp));
      const saturated = v.saturated?.lane === li && v.saturated.band === d.band;
      const tailing = v.tailing?.lane === li && v.tailing?.band === d.band;
      blob(p.x, p.y, saturated ? 230 : 180, 4, tailing ? 2.2 : 1, saturated);
      list.push({
        bandIndex: d.band,
        x: Math.round(p.x * 10) / 10,
        y: Math.round(p.y * 10) / 10,
        pixelSource: { x: Math.round(p.x), y: Math.round(p.y) },
        intensity: saturated ? 255 : 208,
        saturated,
        tailing,
        halfWidthPx: d.halfWidth
      });
    }
    bands[LANE_IDS[li]] = list;
  }

  let png = encodeGrayPng(W, H, pixels);
  let width = W;
  let height = H;
  if (v.rotate) {
    const rotated = rotate90Clockwise(pixels, W, H);
    png = encodeGrayPng(H, W, rotated);
    width = H;
    height = W;
  }

  return { png, width, height, lanes, bands };
}

function rotate90Clockwise(src: Uint8Array, w: number, h: number): Uint8Array {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = h - 1 - y;
      const ny = x;
      out[ny * h + nx] = src[y * w + x];
    }
  }
  return out;
}

export function buildMaterials(
  gel: GeneratedGel,
  opts: {
    imageId: string;
    nominalId: string;
    boundariesId: string;
    bandIdPrefix: string;
    orientation: Transform | null;
    sha256: string;
    capturedAt: string;
    exposure: GelImageMaterial['exposure'];
  }
): { image: GelImageMaterial; nominal: LadderNominalMaterial; boundaries: LaneBoundaryMaterial; bandMaterials: BandCenterMaterial[]; images: { id: string; png: Buffer }[] } {
  const image: GelImageMaterial = {
    kind: 'image',
    id: opts.imageId,
    width: gel.width,
    height: gel.height,
    orientation: opts.orientation,
    exposure: opts.exposure,
    capturedAt: opts.capturedAt,
    sha256: opts.sha256
  };
  const nominal: LadderNominalMaterial = {
    kind: 'ladder-nominal',
    id: opts.nominalId,
    ladderId: 'ladder-1kb-ext',
    valuesBp: [...LADDER_BP],
    source: '1 kb Extended DNA Ladder datasheet (offline case fixture)'
  };
  const lanes: LaneSpec[] = gel.lanes.map((l) => ({
    laneId: l.laneId,
    role: l.role,
    name: l.name,
    centerline: l.centerline
  }));
  const boundaries: LaneBoundaryMaterial = {
    kind: 'lane-boundaries',
    id: opts.boundariesId,
    imageId: opts.imageId,
    lanes
  };
  const bandMaterials: BandCenterMaterial[] = Object.entries(gel.bands).map(([laneId, bands]) => ({
    kind: 'band-centers',
    id: `${opts.bandIdPrefix}-${laneId}`,
    imageId: opts.imageId,
    laneId,
    bands
  }));
  return {
    image,
    nominal,
    boundaries,
    bandMaterials,
    images: [{ id: opts.imageId, png: gel.png }]
  };
}
