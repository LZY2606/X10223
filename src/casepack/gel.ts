/**
 * 离线案例包：胶道标尺 —— 电泳条带、泳道弯曲与分子量校准。
 * 全部确定性合成（无随机数），保证等价输入得到稳定顺序与稳定摘要。
 */
import { encodeGrayPng } from "../shared/png";
import { sha256 } from "../shared/util";

export const GEL_WIDTH = 480;
export const GEL_HEIGHT = 640;
export const GEL_TOP = 40; // 加样孔位置（px, raw 坐标）
export const LADDER_NOMINAL_BP = [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1500, 1000, 500];

/** 迁移距离模型：s = A - B * log10(mw)。 */
export const MIGRATION_A = 1060;
export const MIGRATION_B = 240;

export function migrationOf(mwBp: number): number {
  return MIGRATION_A - MIGRATION_B * Math.log10(mwBp);
}
export function mwOfMigration(s: number): number {
  return Math.pow(10, (MIGRATION_A - s) / MIGRATION_B);
}

export const LANE_COUNT = 6; // lane 0 = ladder
export const LANE_X0 = 70;
export const LANE_DX = 68;

export interface ScenarioSpec {
  id: string;
  title: string;
  /** 只改动一个直接来源。 */
  perturbation:
    | { kind: "rotate"; deg: 90 }
    | { kind: "curve-lanes"; bendPx: number; smile: number }
    | { kind: "ladder-missing-band"; mwBp: number }
    | { kind: "saturated-band"; lane: number; mwBp: number }
    | { kind: "overlapping-bands"; lane: number; mwA: number; mwB: number }
    | { kind: "nonmonotonic-ruler"; swapMw: [number, number] }
    | { kind: "revise-ladder-band"; mwBp: number; shiftPx: number };
}

export interface GelParams {
  bendPx: number; // 泳道横向弯曲幅度
  smile: number; // “微笑”弯曲：边缘泳道迁移率偏移
  saturated: Array<{ lane: number; mwBp: number }>;
  overlaps: Array<{ lane: number; mwA: number; mwB: number }>;
  ladderMissing: number[]; // 缺失的 ladder 标称值
  ladderSwap: [number, number] | null; // 非单调标尺：交换两个标称值
}

export const BASELINE_PARAMS: GelParams = {
  bendPx: 6,
  smile: 0.05,
  saturated: [],
  overlaps: [],
  ladderMissing: [],
  ladderSwap: null,
};

/** 泳道中心线：x = laneX + bend * sin(pi * y / H)。 */
export function laneCenterX(lane: number, y: number, bendPx: number): number {
  return LANE_X0 + lane * LANE_DX + bendPx * Math.sin((Math.PI * y) / GEL_HEIGHT);
}

/** “微笑”弯曲：同一迁移距离在不同泳道映射到不同 y。 */
export function smileScale(lane: number, smile: number): number {
  const center = (LANE_COUNT - 1) / 2;
  const edge = Math.abs(lane - center) / center; // 0..1
  return 1 + smile * edge * edge;
}

/** 某泳道中迁移距离 s 对应的 y 像素。 */
export function yOfMigration(lane: number, s: number, smile: number): number {
  return GEL_TOP + s * smileScale(lane, smile);
}

export interface BandDraw {
  lane: number;
  mwBp: number;
  amplitude: number;
}

export function sampleBands(params: GelParams): BandDraw[] {
  const bands: BandDraw[] = [
    { lane: 1, mwBp: 4200, amplitude: 180 },
    { lane: 1, mwBp: 900, amplitude: 160 },
    { lane: 2, mwBp: 2600, amplitude: 170 },
    { lane: 3, mwBp: 5200, amplitude: 150 },
    { lane: 3, mwBp: 1300, amplitude: 150 },
    { lane: 4, mwBp: 700, amplitude: 160 },
    { lane: 5, mwBp: 3300, amplitude: 150 },
    { lane: 5, mwBp: 1100, amplitude: 140 },
  ];
  for (const sat of params.saturated) {
    bands.push({ lane: sat.lane, mwBp: sat.mwBp, amplitude: 4000 });
  }
  for (const ov of params.overlaps) {
    bands.push({ lane: ov.lane, mwBp: ov.mwA, amplitude: 160 });
    bands.push({ lane: ov.lane, mwBp: ov.mwB, amplitude: 160 });
  }
  return bands;
}

export function ladderBands(params: GelParams): Array<{ mwBp: number }> {
  let nominal = [...LADDER_NOMINAL_BP];
  if (params.ladderSwap) {
    const [a, b] = params.ladderSwap;
    nominal = nominal.map((v) => (v === a ? b : v === b ? a : v));
  }
  return nominal
    .filter((mw) => !params.ladderMissing.includes(mw))
    .map((mwBp) => ({ mwBp }));
}

/** 合成凝胶图像（raw 拍摄坐标，灰度）。 */
export function synthesizeGel(params: GelParams): { pixels: Uint8Array; width: number; height: number } {
  const width = GEL_WIDTH;
  const height = GEL_HEIGHT;
  const px = new Float64Array(width * height);
  for (let i = 0; i < px.length; i++) px[i] = 18; // 背景

  const drawBand = (lane: number, mwBp: number, amplitude: number) => {
    const s = migrationOf(mwBp);
    const cy = yOfMigration(lane, s, params.smile);
    const sx = 7;
    const sy = 3.2;
    const y0 = Math.max(0, Math.floor(cy - 12));
    const y1 = Math.min(height - 1, Math.ceil(cy + 12));
    const x0 = Math.max(0, Math.floor(LANE_X0 + lane * LANE_DX - 30));
    const x1 = Math.min(width - 1, Math.ceil(LANE_X0 + lane * LANE_DX + 30));
    for (let y = y0; y <= y1; y++) {
      const laneX = laneCenterX(lane, y, params.bendPx);
      for (let x = x0; x <= x1; x++) {
        const dx = (x - laneX) / sx;
        const dy = (y - cy) / sy;
        px[y * width + x] += amplitude * Math.exp(-(dx * dx + dy * dy) / 2);
      }
    }
  };

  for (const b of ladderBands(params)) drawBand(0, b.mwBp, 170);
  for (const b of sampleBands(params)) drawBand(b.lane, b.mwBp, b.amplitude);

  const out = new Uint8Array(width * height);
  for (let i = 0; i < px.length; i++) out[i] = Math.max(0, Math.min(255, Math.round(px[i])));
  return { pixels: out, width, height };
}

/** 旋转 90°（顺时针），raw 像素级变换，来源可追溯。 */
export function rotate90(src: { pixels: Uint8Array; width: number; height: number }) {
  const { pixels, width, height } = src;
  const out = new Uint8Array(width * height);
  for (let y = 0; y < height; y++)
    for (let x = 0; x < width; x++) {
      const nx = height - 1 - y;
      const ny = x;
      out[ny * height + nx] = pixels[y * width + x];
    }
  return { pixels: out, width: height, height: width };
}

export function gelPng(params: GelParams, rotate = false): Buffer {
  let img = synthesizeGel(params);
  if (rotate) img = rotate90(img);
  return encodeGrayPng(img.width, img.height, img.pixels);
}

export function gelDigest(params: GelParams, rotate = false): string {
  return sha256(gelPng(params, rotate));
}

export const SCENARIOS: ScenarioSpec[] = [
  { id: "scn-rotate", title: "旋转图像", perturbation: { kind: "rotate", deg: 90 } },
  { id: "scn-curve", title: "弯曲泳道（微笑）", perturbation: { kind: "curve-lanes", bendPx: 14, smile: 0.12 } },
  { id: "scn-ladder-gap", title: "ladder 缺带", perturbation: { kind: "ladder-missing-band", mwBp: 1500 } },
  { id: "scn-saturated", title: "饱和区", perturbation: { kind: "saturated-band", lane: 2, mwBp: 1800 } },
  { id: "scn-overlap", title: "两条带重叠", perturbation: { kind: "overlapping-bands", lane: 4, mwA: 2400, mwB: 2500 } },
  { id: "scn-nonmono", title: "非单调标尺", perturbation: { kind: "nonmonotonic-ruler", swapMw: [4000, 3000] } },
  { id: "scn-revise", title: "修订后局部失效", perturbation: { kind: "revise-ladder-band", mwBp: 2000, shiftPx: 18 } },
];
