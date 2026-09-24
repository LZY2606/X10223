// 合成凝胶场景：生成灰度图像与像素级真值（lane 中心线、条带中心）。
// 仅用于离线案例包；所有真值都以像素坐标记录，作为不可变材料进入系统。
import { encodeGrayPng } from './png.js';

export const WELL_Y = 40;
export const IMG_W = 640;
export const IMG_H = 480;

// 迁移模型（仅用于造数据，引擎不知道它）：弧长 s = K1 - K2*log10(mw)
const K1 = 1043.9;
const K2 = 245.97;
export function sForMw(mw: number): number { return K1 - K2 * Math.log10(mw); }

export interface BandSpec {
  id: string;
  laneId: string;
  mw: number;          // bp（样品的"真实"值，仅造数据用）
  amp: number;         // 峰值强度
  saturate?: boolean;  // 画成饱和平台
  yJitter?: number;    // 额外纵向偏移（用于重叠对）
}

export interface SceneSpec {
  smileAmp: number;                 // “微笑”弯曲幅度（px）
  laneBend: number;                 // 泳道横向弯曲幅度（px）
  ladderNominal: number[];          // ladder 标称值（bp）
  ladderMissing?: number[];         // 这些标称值不画（缺带）
  sampleBands: BandSpec[];
  rotateRaw?: 0 | 90;               // 原始像素相对校正方向的旋转
}

export const LANE_X: Record<string, number> = {
  L1: 90, L2: 170, L3: 250, L4: 330, L5: 410, L6: 490,
};

export function smileOffset(x: number, amp: number): number {
  const t = (x - IMG_W / 2) / (IMG_W / 2);
  return amp * (1 - t * t); // 中间泳道迁移更远
}

export function laneXAt(laneX: number, y: number, bend: number): number {
  return laneX + bend * Math.sin((Math.PI * y) / IMG_H);
}

export interface RenderedScene {
  png: Buffer;             // 原始像素（可能带旋转）
  width: number;
  height: number;
  centerlines: Record<string, Array<{ x: number; y: number }>>; // oriented 坐标
  bandCenters: Array<{ id: string; laneId: string; x: number; y: number }>; // oriented 坐标
}

export function renderScene(spec: SceneSpec): RenderedScene {
  const gray = new Float64Array(IMG_W * IMG_H);
  // 背景：暗场 + 轻微梯度与噪声
  let seed = 42;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  for (let y = 0; y < IMG_H; y++)
    for (let x = 0; x < IMG_W; x++)
      gray[y * IMG_W + x] = 18 + 6 * (y / IMG_H) + rand() * 3;

  const bandCenters: RenderedScene['bandCenters'] = [];
  const drawBand = (laneId: string, mw: number, amp: number, saturate: boolean, yJitter: number, id: string) => {
    const laneX = LANE_X[laneId];
    const s = sForMw(mw) + yJitter;
    const cy = WELL_Y + s + smileOffset(laneX, spec.smileAmp);
    const cx = laneXAt(laneX, cy, spec.laneBend);
    const sx = 7, sy = 2.6;
    for (let y = Math.max(0, Math.floor(cy - 12)); y < Math.min(IMG_H, Math.ceil(cy + 12)); y++) {
      for (let x = Math.max(0, Math.floor(cx - 24)); x < Math.min(IMG_W, Math.ceil(cx + 24)); x++) {
        const dx = (x - cx) / sx, dy = (y - cy) / sy;
        const v = amp * Math.exp(-(dx * dx + dy * dy) / 2);
        const i = y * IMG_W + x;
        gray[i] = saturate ? Math.min(255, gray[i] + v) : gray[i] + v;
      }
    }
    bandCenters.push({ id, laneId, x: Math.round(cx), y: Math.round(cy) });
  };

  spec.ladderNominal.forEach((mw, i) => {
    if (spec.ladderMissing?.includes(mw)) return;
    drawBand('L1', mw, 150, false, 0, `lad_${i}`);
  });
  for (const b of spec.sampleBands) drawBand(b.laneId, b.mw, b.amp, b.saturate ?? false, b.yJitter ?? 0, b.id);

  const pixels = new Uint8Array(IMG_W * IMG_H);
  for (let i = 0; i < pixels.length; i++) pixels[i] = Math.max(0, Math.min(255, Math.round(gray[i])));

  // 中心线（oriented 坐标，每 16px 一个点）
  const centerlines: RenderedScene['centerlines'] = {};
  for (const [laneId, laneX] of Object.entries(LANE_X)) {
    const pts: Array<{ x: number; y: number }> = [];
    for (let y = WELL_Y; y < IMG_H - 8; y += 16) pts.push({ x: Math.round(laneXAt(laneX, y, spec.laneBend)), y });
    centerlines[laneId] = pts;
  }

  if (spec.rotateRaw === 90) {
    // 原始像素顺时针旋转 90° 存储；orientation 材料记录如何转回。
    const rot = new Uint8Array(IMG_W * IMG_H);
    for (let y = 0; y < IMG_H; y++)
      for (let x = 0; x < IMG_W; x++)
        rot[x * IMG_H + (IMG_H - 1 - y)] = pixels[y * IMG_W + x];
    return { png: encodeGrayPng(IMG_H, IMG_W, rot), width: IMG_H, height: IMG_W, centerlines, bandCenters };
  }
  return { png: encodeGrayPng(IMG_W, IMG_H, pixels), width: IMG_W, height: IMG_H, centerlines, bandCenters };
}
