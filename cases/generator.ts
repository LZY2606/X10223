import { encodeGrayPng, stampBand, stampSmear, type GrayImage } from '../shared/png.js';
import type {
  BandCenterMaterial,
  ExposureMaterial,
  ImageMaterial,
  LadderNominalMaterial,
  LaneBoundaryMaterial,
  OrientationMaterial,
  PixelPoint,
  PixelSource,
  Quantity
} from '../shared/types.js';
import { sha256Hex } from '../shared/hash.js';

/** 确定性 PRNG（mulberry32），等价输入 => 等价图像与稳定身份 */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const GEL_W = 360;
export const GEL_H = 480;
const WELL_Y = 28;
const BOTTOM_Y = 452;

/** 常用 dsDNA 7 带 ladder（bp），自大到小 = 自上到下 */
export const STANDARD_LADDER_BP = [10000, 5000, 3000, 2000, 1500, 1000, 500];

export interface ScenarioOptions {
  seed: number;
  /** 微笑弯曲幅度（像素），0 表示直泳道 */
  smile: number;
  /** 泳道额外弯曲（正弦振幅，像素） */
  warp: number;
  /** 标称带缺失：缺失的 ladder 行索引集合 */
  missingBands: Set<number>;
  /** 饱和：饱和的 ladder 行索引集合 */
  saturatedLadder: Set<number>;
  /** 非单调：交换相邻标称顺序的索引对（小的在前），如 [3,4] */
  swapPair?: [number, number];
  /** 重叠：样品带重叠定义 */
  overlap?: { laneIndex: number; yFraction: number; gapPx: number };
  /** 拖尾样品带 */
  smearLanes: number[];
  /** 拍摄方向帧 */
  frame: 'original' | 'rot90' | 'rot180' | 'rot270';
  /** 曝光饱和级（null => 不提供，系统须诊断而非默认） */
  saturationLevel: number | null;
}

export const BASE_OPTIONS: ScenarioOptions = {
  seed: 1194,
  smile: 0,
  warp: 0,
  missingBands: new Set<number>(),
  saturatedLadder: new Set<number>(),
  smearLanes: [],
  frame: 'original',
  saturationLevel: 245
};

export interface GeneratedMaterial {
  image: ImageMaterial;
  orientation: OrientationMaterial;
  exposure: ExposureMaterial;
  lanes: LaneBoundaryMaterial[];
  ladder: LadderNominalMaterial;
  bands: BandCenterMaterial[];
  png: Buffer;
  /** 未旋转的基础灰度（像素级证据来源） */
  gray: GrayImage;
  laneX: number[];
  ladderSFraction: number[];
  bandPositions: { laneIndex: number; yFraction: number; shape: BandShapeHint; mwBp: number }[];
}
type BandShapeHint = 'compact' | 'saturated' | 'smear' | 'overlap';

const LANE_INDEX = [0, 6]; // 边缘两条 ladder 泳道
export const SAMPLE_LANE_INDICES = [1, 2, 3, 4, 5];

function logInterpFraction(bandsBp: number[], yFractions: number[], mw: number): number {
  const logVals = bandsBp.map((v) => Math.log10(v));
  const target = Math.log10(mw);
  for (let i = 0; i < logVals.length - 1; i++) {
    if (target <= logVals[i] && target >= logVals[i + 1]) {
      const t = (logVals[i] - target) / (logVals[i] - logVals[i + 1]);
      return yFractions[i] + t * (yFractions[i + 1] - yFractions[i]);
    }
  }
  return yFractions[yFractions.length - 1];
}

/** 标称位置（迁移分数 0..1），可按选项打乱为非单调 */
function nominalFractions(n: number): number[] {
  const arr: number[] = [];
  for (let i = 0; i < n; i++) arr.push(0.12 + (0.72 * i) / (n - 1));
  return arr;
}

function laneCenterX(laneIndex: number): number {
  return 36 + laneIndex * 48; // 7 lanes: 36,84,...,324
}

/** 弯曲中心线：二次微笑 + 正弦弯曲 */
function centerlineFor(laneIndex: number, opt: ScenarioOptions): PixelPoint[] {
  const xBase = laneCenterX(laneIndex);
  const pts: PixelPoint[] = [];
  for (let y = WELL_Y; y <= BOTTOM_Y; y += 4) {
    const f = (y - WELL_Y) / (BOTTOM_Y - WELL_Y);
    // 微笑：两端 ladder 泳道位移小，中间泳道位移最大（边缘 0.15 倍）
    const edgeFactor = LANE_INDEX.includes(laneIndex) ? 0.15 : 1;
    const smileOffset = opt.smile * 4 * f * (1 - f) * edgeFactor;
    const warpOffset = opt.warp * Math.sin(f * Math.PI * 2 + laneIndex * 0.7);
    pts.push({ x: Math.round((xBase + smileOffset + warpOffset) * 10) / 10, y, frame: 'original' });
  }
  return pts;
}

function contourEllipse(c: PixelSource, rx: number, ry: number): PixelPoint[] {
  const pts: PixelPoint[] = [];
  for (let a = 0; a < 360; a += 24) {
    const rad = (a * Math.PI) / 180;
    pts.push({
      x: Math.round((c.x + rx * Math.cos(rad)) * 10) / 10,
      y: Math.round((c.y + ry * Math.sin(rad)) * 10) / 10,
      frame: c.frame
    });
  }
  return pts;
}

/** 样品带真值（bp）—— 故意让部分样品落在中间深度以体现微笑差异 */
const SAMPLE_TRUTH: Record<number, number[]> = {
  1: [6000, 2400, 900],
  2: [4000, 1700],
  3: [7500, 2600, 1200],
  4: [3500, 1300],
  5: [9000, 5500, 2100, 700]
};

export function generateGel(caseName: string, opt: ScenarioOptions): GeneratedMaterial {
  const rand = mulberry32(opt.seed);
  const nBands = STANDARD_LADDER_BP.length;
  const fractions = nominalFractions(nBands);
  if (opt.swapPair) {
    const [a, b] = opt.swapPair;
    const v = fractions[a];
    fractions[a] = fractions[b];
    fractions[b] = v;
  }

  const gray: GrayImage = {
    width: GEL_W,
    height: GEL_H,
    data: new Uint8Array(GEL_W * GEL_H).fill(228)
  };
  // 轻微背景噪声（确定性）
  for (let i = 0; i < gray.data.length; i++) {
    gray.data[i] = Math.max(0, Math.min(255, gray.data[i] + Math.floor(rand() * 12) - 6));
  }

  const lanes: LaneBoundaryMaterial[] = [];
  const laneX: number[] = [];
  const allCenterlines: PixelPoint[][] = [];
  for (let li = 0; li < 7; li++) {
    const centerline = centerlineFor(li, opt);
    allCenterlines.push(centerline);
    laneX.push(laneCenterX(li));
    const half = 17;
    const leftEdge = centerline.map((p) => ({ x: p.x - half, y: p.y, frame: 'original' as const }));
    const rightEdge = centerline.map((p) => ({ x: p.x + half, y: p.y, frame: 'original' as const }));
    lanes.push({
      kind: 'lane_boundary',
      id: `lane_${li}`,
      version: 1,
      imageId: `img_${caseName}`,
      role: LANE_INDEX.includes(li) ? 'ladder' : 'sample',
      label: LANE_INDEX.includes(li) ? `Ladder L${li}` : `Sample S${li}`,
      leftEdge,
      rightEdge,
      centerline
    });
  }

  const bands: BandCenterMaterial[] = [];
  const bandPositions: GeneratedMaterial['bandPositions'] = [];

  // --- ladder 带（两条边缘泳道），缺带只在 lane_0 上体现以形成缺口 ---
  for (let li of [0, 6]) {
    for (let bi = 0; bi < nBands; bi++) {
      const missing = li === 0 && opt.missingBands.has(bi);
      if (missing) continue;
      const p = allCenterlines[li][Math.round((fractions[bi] * (allCenterlines[li].length - 1)))];
      const saturated = opt.saturatedLadder.has(bi);
      const darkness = saturated ? 255 : 150 + Math.floor(rand() * 30);
      stampBand(gray, p.x, p.y, 11, 4.2, darkness);
      const center: PixelSource = {
        x: Math.round(p.x * 10) / 10,
        y: p.y,
        imageId: `img_${caseName}`,
        frame: 'original',
        provenance: 'auto'
      };
      bands.push({
        kind: 'band_center',
        id: `band_l${li}_${bi}`,
        version: 1,
        imageId: `img_${caseName}`,
        laneId: `lane_${li}`,
        center,
        contour: contourEllipse(center, 11, 4.5),
        shape: saturated ? 'saturated' : 'compact',
        peakIntensity: Math.max(0, 228 - darkness),
        smearTailPx: 0
      });
    }
  }

  // --- 样品带 ---
  for (const li of SAMPLE_LANE_INDICES) {
    const truth = SAMPLE_TRUTH[li] ?? [];
    for (let ti = 0; ti < truth.length; ti++) {
      const mw = truth[ti];
      let frac = logInterpFraction(STANDARD_LADDER_BP, nominalFractions(nBands), mw);
      let shape: BandShapeHint = opt.smearLanes.includes(li) && ti === truth.length - 1 ? 'smear' : 'compact';
      const line = allCenterlines[li];
      let p = line[Math.round(frac * (line.length - 1))];
      let overlapsWith: string | undefined;
      let bandId = `band_l${li}_${ti}`;
      let y = p.y;

      if (opt.overlap && opt.overlap.laneIndex === li && ti === 0) {
        // 两条带重叠：近距离双峰
        const y2 = y + opt.overlap.gapPx;
        const p2 = line[Math.min(line.length - 1, Math.round((y2 - WELL_Y) / (BOTTOM_Y - WELL_Y) * (line.length - 1)))];
        stampBand(gray, p.x, p.y, 11, 4, 150);
        stampBand(gray, p2.x, p2.y, 11, 4, 150);
        const c1: PixelSource = { x: Math.round(p.x * 10) / 10, y: p.y, imageId: `img_${caseName}`, frame: 'original', provenance: 'auto' };
        const c2: PixelSource = { x: Math.round(p2.x * 10) / 10, y: p2.y, imageId: `img_${caseName}`, frame: 'original', provenance: 'auto' };
        bands.push({
          kind: 'band_center', id: bandId, version: 1, imageId: `img_${caseName}`, laneId: `lane_${li}`,
          center: c1, contour: contourEllipse(c1, 11, 4.5), shape: 'overlap', peakIntensity: 78,
          overlapsWith: `band_l${li}_${ti}b`, smearTailPx: 0
        });
        bands.push({
          kind: 'band_center', id: `band_l${li}_${ti}b`, version: 1, imageId: `img_${caseName}`, laneId: `lane_${li}`,
          center: c2, contour: contourEllipse(c2, 11, 4.5), shape: 'overlap', peakIntensity: 78,
          overlapsWith: bandId, smearTailPx: 0
        });
        bandPositions.push({ laneIndex: li, yFraction: frac, shape: 'overlap', mwBp: mw });
        continue;
      }

      if (shape === 'smear') {
        stampBand(gray, p.x, p.y, 10, 5, 140);
        stampSmear(gray, p.x, p.y, 9, 34, 130);
      } else {
        stampBand(gray, p.x, y, 11, 4.2, 150 + Math.floor(rand() * 25));
      }
      const center: PixelSource = {
        x: Math.round(p.x * 10) / 10, y, imageId: `img_${caseName}`, frame: 'original', provenance: 'auto'
      };
      bands.push({
        kind: 'band_center',
        id: bandId,
        version: 1,
        imageId: `img_${caseName}`,
        laneId: `lane_${li}`,
        center,
        contour: contourEllipse(center, 11, shape === 'smear' ? 20 : 4.5),
        shape,
        peakIntensity: shape === 'smear' ? 88 : 72 + Math.floor(rand() * 12),
        smearTailPx: shape === 'smear' ? 34 : 0
      });
      bandPositions.push({ laneIndex: li, yFraction: frac, shape, mwBp: mw });
    }
  }
