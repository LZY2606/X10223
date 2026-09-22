import { encodeGrayPng } from './png';
import type { PixelPos } from '../shared/types';

export type Scenario =
  | 'baseline'
  | 'rotation'
  | 'curved-lanes'
  | 'missing-ladder-band'
  | 'saturation'
  | 'overlap'
  | 'nonmonotonic'
  | 'revision-local-failure';

export interface GelSpec {
  scenario: Scenario;
  width: number;
  height: number;
  lanes: number;
  /** 各条带：laneIndex, 迁移比例 0..1, 强度倍数(>1 饱和), 是否拖尾, 宽度倍率 */
  bands: Array<{ lane: number; mig: number; amp: number; smear?: boolean; w?: number }>;
  /** lane 中心弯曲幅度（像素，微笑） */
  smilePx: number;
  /** 标称分子量（bp），长度 = ladder 可见条数（缺带场景会少画一条） */
  ladderNominals: number[];
}

export interface GeneratedGel {
  png: Buffer;
  width: number;
  height: number;
  /** 真值 lane 脊柱（像素），按 laneIndex */
  spines: PixelPos[][];
  /** 真值条带中心（像素），与 bands 同序 */
  centers: PixelPos[];
}

const W = 560;
const H = 460;
const TOP = 42;
const BOTTOM = 420;
const LANE_X0 = 70;
const LANE_DX = 105;
const HALF_W = 30;

/** lane 0 = ladder；典型 1000~100 bp ladder */
export const DEFAULT_LADDER = [1000, 850, 700, 600, 500, 400, 300, 200, 100];

export function scenarioSpec(scenario: Scenario): GelSpec {
  const migs = [0.08, 0.19, 0.3, 0.41, 0.52, 0.63, 0.74, 0.85, 0.94];
  const smile = scenario === 'curved-lanes' ? 26 : scenario === 'baseline' ? 4 : 10;
  const bands: GelSpec['bands'] = [];
  // ladder 条带
  let nominals = [...DEFAULT_LADDER];
  for (let i = 0; i < migs.length; i++) {
    if (scenario === 'missing-ladder-band' && i === 3) continue; // 故意缺第 4 条 (600bp)
    bands.push({ lane: 0, mig: migs[i], amp: 0.95 });
  }
  if (scenario === 'missing-ladder-band') nominals = nominals.filter((v) => v !== 600);
  if (scenario === 'nonmonotonic') {
    // 标称值本身改成非单调（第 3、4 条互换制造上升）
    nominals = [1000, 850, 600, 700, 500, 400, 300, 200, 100];
  }

  // 样品 lane 1
  const sample = (lane: number, items: Array<[number, number, boolean?]>) =>
    items.forEach(([mig, amp, smear]) => bands.push({ lane, mig, amp, smear }));

  sample(1, [[0.3, 0.9], [0.63, 0.85], [0.85, 0.9]]);
  if (scenario === 'saturation') sample(1, [[0.52, 1.9]]);
  else sample(1, [[0.52, 0.88]]);
  if (scenario === 'overlap') sample(1, [[0.555, 0.85]]); // 与 0.52 很近
  if (scenario === 'smear' as Scenario) sample(1, [[0.74, 0.8, true]]);

  sample(2, [[0.19, 0.9], [0.52, 0.8], [0.74, 0.9], [0.94, 0.85]]);
  sample(3, [[0.41, 0.9], [0.63, 0.9]]);
  if (scenario === 'revision-local-failure') {
    // 一条 ladder 条带人工拖到错误位置造成局部非单调，由事件层处理；这里保持图像正常
    sample(1, [[0.08, 0.8]]);
  }
  return {
    scenario,
    width: W,
    height: H,
    lanes: 4,
    bands,
    smilePx: smile,
    ladderNominals: nominals,
  };
}

function spineFor(lane: number, smilePx: number): PixelPos[] {
  const cx = LANE_X0 + lane * LANE_DX;
  const pts: PixelPos[] = [];
  const steps = 24;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const y = TOP + t * (BOTTOM - TOP);
    // 微笑：两端向中心弯（抛物线）
    const x = cx + smilePx * (1 - 4 * (t - 0.5) ** 2) * (lane === 0 || lane === 2 ? 1 : -1);
    pts.push({ x: Math.round(x * 10) / 10, y: Math.round(y * 10) / 10 });
  }
  return pts;
}

function pointOnSpine(spine: PixelPos[], mig: number): PixelPos {
  const y = TOP + mig * (BOTTOM - TOP);
  let lo = spine[0];
  for (let i = 0; i < spine.length - 1; i++) {
    if (y >= spine[i].y && y <= spine[i + 1].y) {
      const t = (y - spine[i].y) / (spine[i + 1].y - spine[i].y || 1);
      return { x: spine[i].x + t * (spine[i + 1].x - spine[i].x), y };
    }
    lo = spine[i + 1];
  }
  return lo;
}

export function generateGel(spec: GelSpec, noise = 6): GeneratedGel {
  const { width, height } = spec;
  const gray = new Uint8Array(width * height);
  // 暗背景 + 轻微噪点 + lane 底色
  let seed = 1337 + spec.scenario.length * 101 + spec.smilePx;
  const rnd = () => {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  const spines = Array.from({ length: spec.lanes }, (_, l) => spineFor(l, spec.smilePx));
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      let v = 18 + rnd() * noise;
      for (let l = 0; l < spec.lanes; l++) {
        const p = pointOnSpine(spines[l], Math.max(0, Math.min(1, (y - TOP) / (BOTTOM - TOP))));
        if (Math.abs(x - p.x) < HALF_W) v += 4;
      }
      gray[y * width + x] = Math.min(255, v);
    }
  }
  const centers: PixelPos[] = [];
  for (const b of spec.bands) {
    const spine = spines[b.lane];
    const c = pointOnSpine(spine, b.mig);
    centers.push({ x: Math.round(c.x * 10) / 10, y: Math.round(c.y * 10) / 10 });
    const bandW = (b.w ?? 1) * 13;
    const spreadY = b.smear ? 30 : 9;
    for (let y = Math.max(0, Math.floor(c.y - spreadY * 2)); y < Math.min(height, Math.ceil(c.y + spreadY * 2)); y++) {
      for (let x = Math.max(0, Math.floor(c.x - bandW)); x < Math.min(width, Math.ceil(c.x + bandW)); x++) {
        const dx = (x - c.x) / bandW;
        const dy = (y - c.y) / spreadY;
        const g = 200 * b.amp * Math.exp(-(dx * dx * 3.2 + dy * dy * (b.smear ? 2.2 : 9)));
        const idx = y * width + x;
        gray[idx] = Math.min(255, gray[idx] + g);
      }
    }
  }
  return { png: encodeGrayPng(width, height, gray), width, height, spines, centers };
}
