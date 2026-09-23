import type { PxPoint, PxPolyline } from "./types.js";
import type { GrayImage } from "./png.js";

/** mulberry32 确定性伪随机 */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const GEL_W = 520;
export const GEL_H = 420;

export interface RenderBand {
  laneIndex: number;
  /** 中心 y（直道坐标系，自加样孔向下） */
  y: number;
  /** 半宽全高（纵向 sigma），默认 7 */
  sigmaY?: number;
  /** 横向 sigma（默认 13） */
  sigmaX?: number;
  /** 峰值强度（默认 210），>=252 产生饱和平顶 */
  amp?: number;
}

export interface RenderOptions {
  seed?: number;
  width?: number;
  height?: number;
  laneCount?: number;
  laneCenters?: number[];
  /** 微笑：泳道中心随 y 的横向位移函数索引（0 平直，1 微笑，2 歪斜弯曲） */
  smile?: number;
  /** 在绘制后旋转图像（0/90/180/270，顺时针） */
  rotate?: 0 | 90 | 180 | 270;
  bands: RenderBand[];
  background?: number;
  noise?: number;
  saturationLevel?: number;
}

export interface LaneSpec {
  laneIndex: number;
  cx: number;
  top: number;
  bottom: number;
}

export const LANE_TOP = 46;
export const LANE_BOTTOM = 388;
export const LANE_HALF_WIDTH = 22;

/** 弯曲中心曲线 x(y) */
export function curvedCenterX(baseCx: number, y: number, smile: number, h: number): number {
  if (smile === 1) {
    // 微笑：中间迁移更快 → 中心在中部向下弯（此处是横向视角，用 y 偏移更直观）
    return baseCx;
  }
  if (smile === 2) {
    return baseCx + 14 * Math.sin(((y - LANE_TOP) / (LANE_BOTTOM - LANE_TOP)) * Math.PI);
  }
  return baseCx;
}

/** 弯曲中心曲线 y(x-relative) 的迁移偏移：中部下移（微笑） */
export function smileOffsetY(y: number, smile: number): number {
  if (smile === 1) {
    const t = (y - LANE_TOP) / (LANE_BOTTOM - LANE_TOP);
    return 16 * Math.sin(t * Math.PI); // 中间多迁移 16px
  }
  if (smile === 2) {
    const t = (y - LANE_TOP) / (LANE_BOTTOM - LANE_TOP);
    return 10 * Math.sin(t * Math.PI * 1.3);
  }
  return 0;
}

function rotateGray(img: GrayImage, deg: 90 | 180 | 270): GrayImage {
  if (deg === 0) return img;
  const { width: w, height: h, data } = img;
  if (deg === 180) {
    const out = new Uint8Array(data.length);
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) out[(h - 1 - y) * w + (w - 1 - x)] = data[y * w + x]!;
    return { width: w, height: h, channels: 1, data: out };
  }
  const cw = deg === 90 ? h : h;
  const ch = deg === 90 ? w : w;
  const out = new Uint8Array(cw * ch);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx = 0;
      let ny = 0;
      if (deg === 90) {
        nx = h - 1 - y;
        ny = x;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      out[ny * cw + nx] = data[y * w + x]!;
    }
  }
  return { width: cw, height: ch, channels: 1, data: out };
}

export function renderGel(opts: RenderOptions): { image: GrayImage; lanes: LaneSpec[]; centers: number[] } {
  const width = opts.width ?? GEL_W;
  const height = opts.height ?? GEL_H;
  const laneCount = opts.laneCount ?? (opts.laneCenters?.length ?? 5);
  const centers =
    opts.laneCenters ??
    Array.from({ length: laneCount }, (_, i) => Math.round(((i + 1) * width) / (laneCount + 1)));
  const rand = rng(opts.seed ?? 42);
  const bg = opts.background ?? 24;
  const noise = opts.noise ?? 5;
  const data = new Uint8Array(width * height);

  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const v = bg + rand() * noise + 2 * Math.sin(x * 0.05) * Math.sin(y * 0.03);
      data[y * width + x] = Math.max(0, Math.min(60, v));
    }
  }
  // 加样孔（顶部暗槽）
  for (let li = 0; li < centers.length; li++) {
    const cx = centers[li]!;
    for (let y = LANE_TOP - 14; y < LANE_TOP - 4; y++) {
      for (let x = cx - LANE_HALF_WIDTH; x <= cx + LANE_HALF_WIDTH; x++) {
        data[y * width + x] = 8;
      }
    }
  }

  const setPx = (x: number, y: number, add: number): void => {
    const ix = Math.round(x);
    const iy = Math.round(y);
    if (ix < 0 || iy < 0 || ix >= width || iy >= height) return;
    const idx = iy * width + ix;
    data[idx] = Math.max(0, Math.min(255, data[idx]! + add));
  };

  for (const band of opts.bands) {
    const cx0 = centers[band.laneIndex]!;
    const sy = band.sigmaY ?? 7;
    const sx = band.sigmaX ?? 13;
    const amp = band.amp ?? 210;
    const radiusY = Math.ceil(sy * 3);
    const radiusX = Math.ceil(sx * 3);
    for (let dy = -radiusY; dy <= radiusY; dy++) {
      const wy = Math.exp(-(dy * dy) / (2 * sy * sy));
      const yBase = band.y + dy;
      for (let dx = -radiusX; dx <= radiusX; dx++) {
        const wx = Math.exp(-(dx * dx) / (2 * sx * sx));
        const yEff = yBase;
        const cxEff = curvedCenterX(cx0, yEff, opts.smile ?? 0, height);
        const xEff = cxEff + dx;
        const yFinal = yEff + smileOffsetY(yEff, opts.smile ?? 0) * wx * 1;
        setPx(xEff, yFinal, amp * wx * wy);
      }
    }
  }

  let image: GrayImage = { width, height, channels: 1, data };
  if (opts.rotate) image = rotateGray(image, opts.rotate);
  const lanes: LaneSpec[] = centers.map((cx, i) => ({ laneIndex: i, cx, top: LANE_TOP, bottom: LANE_BOTTOM }));
  return { image, lanes, centers };
}

/** 生成 lane 边界折线（直道或按弯曲函数密集采样） */
export function lanePolylines(baseCx: number, smile: number, halfWidth = LANE_HALF_WIDTH, step = 8): { left: PxPolyline; right: PxPolyline; center: PxPolyline } {
  const leftPts: PxPoint[] = [];
  const rightPts: PxPoint[] = [];
  const centerPts: PxPoint[] = [];
  for (let y = LANE_TOP; y <= LANE_BOTTOM + 1; y += step) {
    const yEff = y + smileOffsetY(y, smile);
    const cx = curvedCenterX(baseCx, y, smile, GEL_H);
    leftPts.push({ x: cx - halfWidth, y: yEff });
    rightPts.push({ x: cx + halfWidth, y: yEff });
    centerPts.push({ x: cx, y: yEff });
  }
  return {
    left: { coord: "raw-px", pts: leftPts },
    right: { coord: "raw-px", pts: rightPts },
    center: { coord: "raw-px", pts: centerPts },
  };
}
