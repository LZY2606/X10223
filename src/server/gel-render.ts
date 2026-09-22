import { createHash } from 'node:crypto';
import { encodeGrayPng } from './png.js';
import { rotatedSize, uprightToRaw } from '../shared/geometry.js';

/** 领域案例配方（案例包是电泳领域材料，不是通用表格） */
export interface GelBandSpec {
  id: string;
  /** 沿泳道弧长比例 0=加样孔端, 1=远端 */
  t: number;
  /** 相对条带宽度（px） */
  sigmaY?: number;
  sigmaX?: number;
  /** 强度 0..1（1=饱和） */
  intensity?: number;
  saturated?: boolean;
  smear?: boolean;
  /** 与同泳道另一带重叠 */
  overlapWith?: string[];
  missing?: boolean;
}

export interface GelLaneSpec {
  id: string;
  label: string;
  /** 水平弯曲幅度（px），smile: 中间向远端凸 */
  curve?: 'straight' | 'smile' | 'frown';
  curveAmpPx?: number;
  bands: GelBandSpec[];
}

export interface GelRecipe {
  slug: string;
  widthPx: number;
  heightPx: number;
  /** 拍摄方向（顺时针） */
  orientationDeg?: 0 | 90 | 180 | 270;
  exposureTimeSec?: number;
  gain?: number;
  laneWidthPx?: number;
  lanes: GelLaneSpec[];
  ladderLaneId: string;
  ladderUnit: 'bp' | 'kDa';
  ladderCatalog: string;
  /** 与 ladder lane bands 同序（加样孔->远端）的标称值原始表示 */
  ladderNominals: { id: string; raw: string; missing?: boolean }[];
}

export interface RenderedGel {
  png: Buffer;
  widthPx: number;
  heightPx: number;
  sha256: string;
  saturatedPixelFraction: number;
  p99Intensity: number;
  maxIntensity: number;
  /** 每条带的 upright 中心像素坐标（渲染真值，供材料层使用） */
  bandCenters: Record<string, { x: number; y: number }>;
  /** 每条泳道的中心折线（upright） */
  laneCenterlines: Record<string, { x: number; y: number }[]>;
  laneBoundaries: Record<string, { left: { x: number; y: number }[]; right: { x: number; y: number }[] }>;
}

const TOP_MARGIN = 28;
const BOTTOM_MARGIN = 28;

function laneCenterX(lane: GelLaneSpec, index: number, total: number, width: number, lanePitch: number): number {
  const start = width / 2 - ((total - 1) * lanePitch) / 2;
  return start + index * lanePitch;
}

export function renderGel(recipe: GelRecipe): RenderedGel {
  const deg = recipe.orientationDeg ?? 0;
  const up = rotatedSize(recipe.widthPx, recipe.heightPx, deg);
  // 在 upright 帧渲染，再旋转变回 raw（模拟原始拍摄方向）
  const w = deg === 0 || deg === 180 ? recipe.widthPx : recipe.heightPx;
  const h = deg === 0 || deg === 180 ? recipe.heightPx : recipe.widthPx;
  const gray = new Uint8Array(w * h).fill(28);

  const lanePitch = w / (recipe.lanes.length + 1);
  const halfW = (recipe.laneWidthPx ?? 26) / 2;
  const bandCenters: RenderedGel['bandCenters'] = {};
  const laneCenterlines: RenderedGel['laneCenterlines'] = {};
  const laneBoundaries: RenderedGel['laneBoundaries'] = {};

  const centersAtY: Record<string, (y: number) => number> = {};

  recipe.lanes.forEach((lane, li) => {
    const cx = laneCenterX(lane, li, recipe.lanes.length, w, lanePitch);
    const amp = lane.curveAmpPx ?? 22;
    const centerAt = (y: number): number => {
      const u = (y - TOP_MARGIN) / (h - TOP_MARGIN - BOTTOM_MARGIN);
      if (lane.curve === 'smile') return cx + amp * Math.sin(Math.PI * u);
      if (lane.curve === 'frown') return cx - amp * Math.sin(Math.PI * u);
      return cx;
    };
    centersAtY[lane.id] = centerAt;
    const ys: number[] = [];
    for (let y = TOP_MARGIN; y <= h - BOTTOM_MARGIN; y += 4) ys.push(y);
    const poly = ys.map((y) => ({ x: centerAt(y), y }));
    laneCenterlines[lane.id] = poly;
    laneBoundaries[lane.id] = {
      left: poly.map((p) => ({ x: p.x - halfW, y: p.y })),
      right: poly.map((p) => ({ x: p.x + halfW, y: p.y })),
    };

    for (const band of lane.bands) {
      if (band.missing) continue;
      const by = TOP_MARGIN + band.t * (h - TOP_MARGIN - BOTTOM_MARGIN);
      const bx = centerAt(by);
      bandCenters[band.id] = { x: bx, y: by };
      const sigmaY = band.sigmaY ?? 5;
      const sigmaX = band.sigmaX ?? halfW * 0.55;
      const peak = band.saturated ? 1.0 : band.intensity ?? 0.75;
      const rY = Math.ceil(sigmaY * (band.smear ? 3.2 : 2.6));
      const rX = Math.ceil(sigmaX * 2.4);
      for (let y = Math.max(0, Math.floor(by - rY)); y <= Math.min(h - 1, Math.ceil(by + rY)); y++) {
        for (let x = Math.max(0, Math.floor(bx - rX)); x <= Math.min(w - 1, Math.ceil(bx + rX)); x++) {
          const cxp = centersAtY[lane.id](y);
          const gx = Math.exp(-(((x - cxp) ** 2) / (2 * sigmaX ** 2)));
          const stretch = band.smear ? 1 + 0.9 * Math.max(0, (y - by) / Math.max(rY, 1)) : 1;
          const gy = Math.exp(-(((y - by) ** 2) / (2 * (sigmaY * stretch) ** 2)));
          const v = Math.min(1, peak * gx * gy);
          const idx = y * w + x;
          const base = gray[idx];
          const add = Math.round(v * 235);
          gray[idx] = Math.min(255, base + add);
        }
      }
    }
  });

  // 轻微噪声
  let seed = 1337;
  const rand = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let i = 0; i < gray.length; i++) gray[i] = Math.max(0, Math.min(255, gray[i] + Math.round((rand() - 0.5) * 7)));

  // raw 帧：把 upright 图旋转回拍摄角度
  const finalSize = { width: recipe.widthPx, height: recipe.heightPx };
  const raw = new Uint8Array(finalSize.width * finalSize.height).fill(28);
  for (let y = 0; y < finalSize.height; y++) {
    for (let x = 0; x < finalSize.width; x++) {
      const upP = uprightToRaw({ x: x + 0.5, y: y + 0.5 }, {
        kind: 'raw',
        rotationDeg: deg,
        unit: 'px',
        width: finalSize.width,
        height: finalSize.height,
      });
      const ux = Math.floor(upP.x - 0.5);
      const uy = Math.floor(upP.y - 0.5);
      if (ux >= 0 && ux < w && uy >= 0 && uy < h) raw[y * finalSize.width + x] = gray[uy * w + ux];
    }
  }

  const sorted = [...raw].sort((a, b) => a - b);
  const p99 = sorted[Math.floor(sorted.length * 0.99)];
  const satCount = raw.reduce((a, v) => a + (v >= 255 ? 1 : 0), 0);
  const png = encodeGrayPng(finalSize.width, finalSize.height, raw);
  return {
    png,
    widthPx: finalSize.width,
    heightPx: finalSize.height,
    sha256: createHash('sha256').update(png).digest('hex'),
    saturatedPixelFraction: satCount / raw.length,
    p99Intensity: p99,
    maxIntensity: 255,
    bandCenters,
    laneCenterlines,
    laneBoundaries,
  };
}
