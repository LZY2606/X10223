import type { CoordFrame, PixelPoint } from './types';
import { gaussian, type XY } from './geometry';
import type { GrayImage } from './png';

/**
 * 领域专用合成凝胶：dark-bg / 亮带，含 ladder 泳道与样本泳道。
 * 生成的一切几何（lane 边界、ladder 条带中心）都带像素级来源，供基线材料使用。
 */

export const GEL_WIDTH = 640;
export const GEL_HEIGHT = 480;
export const LANE_HALF_WIDTH = 26;
export const LANE_TOP = 40;
export const LANE_BOTTOM = 452;
export const BACKGROUND = 26;

/** 常用 dsDNA ladder（bp），序数自加样孔向下 */
export const DEFAULT_LADDER_BP = [1000, 700, 500, 400, 300, 200, 100];

/** log10(bp) 与迁移弧长 s 的“真值”关系（确定性），s 向下增大 */
export function truthSForMw(mw: number): number {
  return 70 - 132 * Math.log10(mw / 100);
}

export function truthMwForS(s: number): number {
  return 100 * 10 ** ((s - 70) / -132);
}

export interface GelSpec {
  width?: number;
  height?: number;
  ladderBp?: number[];
  /** 样本泳道中每条带的真值 bp（位于 ladder 右侧泳道） */
  sampleBands: { lane: number; bp: number; saturated?: boolean; tail?: boolean }[][];
  /** 微笑弯曲幅度(px)：>0 时泳道中部相对两端向迁移方向弯曲 */
  smilePx?: number;
  ladderLaneX?: number;
  laneSpacing?: number;
  missingLadderBp?: number[];
  /** 两条带重叠：指定泳道内额外插入近距离带（bp） */
  overlapInLane?: number;
  overlapBp?: [number, number];
}

export interface BuiltGel {
  image: GrayImage;
  laneCentersX: number[];
  /** 每条泳道的中心线（含控制点），像素坐标，修正前帧 */
  centerlines: XY[][];
  ladderCenters: { bp: number; x: number; y: number }[];
  sampleTruth: { lane: number; bp: number; x: number; y: number; saturated: boolean; tail: boolean }[];
}

export function laneCenterX(index: number, spec: GelSpec): number {
  const spacing = spec.laneSpacing ?? 88;
  const ladderX = spec.ladderLaneX ?? 70;
  return index === 0 ? ladderX : ladderX + index * spacing;
}

/** 中心线：三次式“微笑”，x 固定，y(s)=s + smile*(s 在两端为0、中部最大) */
export function centerlinePoints(cx: number, smilePx: number): XY[] {
  const points: XY[] = [];
  const span = LANE_BOTTOM - LANE_TOP;
  for (let y = LANE_TOP; y <= LANE_BOTTOM; y += 24) {
    const t = (y - LANE_TOP) / span;
    const dy = smilePx * 4 * t * (1 - t); // 0 -> max -> 0
    points.push({ x: cx, y: y + dy });
  }
  return points;
}

export function buildGel(spec: GelSpec): BuiltGel {
  const width = spec.width ?? GEL_WIDTH;
  const height = spec.height ?? GEL_HEIGHT;
  const pixels = new Uint8Array(width * height).fill(BACKGROUND);
  const ladderBp = spec.ladderBp ?? DEFAULT_LADDER_BP;
  const smile = spec.smilePx ?? 0;
  const laneCount = 1 + spec.sampleBands.length;
  const laneCentersX: number[] = [];
  const centerlines: XY[][] = [];

  for (let i = 0; i < laneCount; i += 1) {
    const cx = laneCenterX(i, spec);
    laneCentersX.push(cx);
    centerlines.push(centerlinePoints(cx, smile));
  }

  const setPx = (x: number, y: number, value: number) => {
    const xi = Math.round(x);
    const yi = Math.round(y);
    if (xi < 0 || yi < 0 || xi >= width || yi >= height) return;
    pixels[yi * width + xi] = Math.min(255, Math.max(pixels[yi * width + xi], value));
  };

  const paintBand = (
    cx: number,
    sTarget: number,
    options: { amp?: number; sigmaX?: number; sigmaY?: number; saturated?: boolean; tail?: boolean } = {}
  ): { x: number; y: number } => {
    // 在中心线按 s 取像素 y（s 从 LANE_TOP 起算）
    const span = LANE_BOTTOM - LANE_TOP;
    const t = sTarget / span;
    const dy = smile * 4 * t * (1 - t);
    const cy = LANE_TOP + sTarget + dy;
    const amp = options.saturated ? 255 : options.amp ?? 205;
    const sigmaX = options.sigmaX ?? 9;
    const sigmaY = options.sigmaY ?? 5;
    const tail = options.tail ?? false;
    const radius = Math.ceil(sigmaX * 3);
    for (let y = cy - sigmaY * 3; y <= cy + (tail ? sigmaY * 9 : sigmaY * 3); y += 1) {
      for (let dx = -radius; dx <= radius; dx += 1) {
        const gy = tail && y > cy
          ? gaussian(y, cy, sigmaY * 2.4, amp * 0.55)
          : gaussian(y, cy, sigmaY, amp);
        const gx = gaussian(cx + dx, cx, sigmaX, 1);
        const value = BACKGROUND + (Math.min(255, gy) - BACKGROUND) * gx;
        setPx(cx + dx, y, Math.round(value));
      }
    }
    return { x: cx, y: cy };
  };

  const ladderCenters: BuiltGel['ladderCenters'] = [];
  const ladderX = laneCentersX[0];
  for (const bp of ladderBp) {
    if ((spec.missingLadderBp ?? []).includes(bp)) continue;
    const sAbs = truthSForMw(bp);
    const at = paintBand(ladderX, sAbs);
    ladderCenters.push({ bp, x: at.x, y: at.y });
  }

  const sampleTruth: BuiltGel['sampleTruth'] = [];
  spec.sampleBands.forEach((bands, idx) => {
    const lane = idx + 1;
    const cx = laneCentersX[lane];
    for (const band of bands) {
      const sAbs = truthSForMw(band.bp);
      const at = paintBand(cx, sAbs, {
        saturated: band.saturated,
        tail: band.tail
      });
      sampleTruth.push({ lane, bp: band.bp, x: at.x, y: at.y, saturated: !!band.saturated, tail: !!band.tail });
    }
  });

  if (spec.overlapInLane !== undefined && spec.overlapBp) {
    const lane = spec.overlapInLane;
    const cx = laneCentersX[lane];
    for (const bp of spec.overlapBp) {
      const at = paintBand(cx, truthSForMw(bp));
      sampleTruth.push({ lane, bp, x: at.x, y: at.y, saturated: false, tail: false });
    }
  }

  return {
    image: { width, height, pixels },
    laneCentersX,
    centerlines,
    ladderCenters,
    sampleTruth
  };
}

export function frameFor(imageId: string, image: GrayImage, rotationDeg: 0 | 90 | 180 | 270 = 0): CoordFrame {
  return {
    imageId,
    widthPx: image.width,
    heightPx: image.height,
    rotationDeg,
    frame: 'raw'
  };
}

export function boundariesFromCenterline(centerline: XY[], provenance: PixelPoint['provenance']) {
  const toPoints = (offset: number): PixelPoint[] =>
    centerline.map((p) => ({ x: Math.round(p.x + offset), y: Math.round(p.y), provenance }));
  return {
    leftBoundary: { spine: toPoints(-LANE_HALF_WIDTH), halfWidthPx: 2 },
    rightBoundary: { spine: toPoints(LANE_HALF_WIDTH), halfWidthPx: 2 }
  };
}
