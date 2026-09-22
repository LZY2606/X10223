/**
 * 离线领域案例材料生成器：确定性合成电泳图（8 位灰度 PNG 数据）。
 * 用真实几何与光度模型表达 ladder/lane/band：
 *  - 微笑弯曲：泳道中心线 x 随弧向 u 呈二次偏移，同一像素高度不再对应同一分子量；
 *  - 拖尾：沿迁移方向不对称高斯；
 *  - 饱和：峰值截断到 255（clipping）；
 *  - 重叠：两个相近的高斯峰；
 * 生成结果同时产出像素级真值（lane 边界、条带中心），作为材料导入并保留来源。
 */
import { makeRaster, setPx, type Raster } from '../raster.js';

export interface SynBand {
  /** 沿中心线自上向下的迁移位置 u（px） */
  u: number;
  /** 峰高（0..255，255 即饱和） */
  amp: number;
  /** 纵向 sigma（px） */
  sigmaU: number;
  /** 拖尾系数：>0 向下（迁移方向）拖尾 */
  tail?: number;
}

export interface SynLane {
  id: string;
  label: string;
  /** 中心线起点像素坐标 */
  xCenter: number;
  /** 泳道半宽（px） */
  halfWidth: number;
  /** 微笑二次项系数：x(u) = xCenter + smile*a*(a-1) */
  smile?: number;
  bands: SynBand[];
  isLadder?: boolean;
}

export interface SynGelSpec {
  width: number;
  height: number;
  background: number;
  noiseAmp: number;
  lanes: SynLane[];
  /** 随机种子（确定性） */
  seed: number;
}

/** 确定性 LCG 噪声 */
function rng(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (1664525 * s + 1013904223) >>> 0;
    return s / 0xffffffff;
  };
}

/** 中心线：u 从 laneTop 到 laneBottom，带微笑弯曲 */
export function laneCenterline(
  lane: SynLane,
  laneTop: number,
  laneBottom: number,
  samples = 80
): { x: number; y: number }[] {
  const out: { x: number; y: number }[] = [];
  const span = laneBottom - laneTop;
  for (let i = 0; i < samples; i++) {
    const y = laneTop + (span * i) / (samples - 1);
    const a = (y - laneTop) / span; // 0..1
    const x = lane.xCenter + (lane.smile ?? 0) * 4 * a * (a - 1);
    out.push({ x, y });
  }
  return out;
}

/** 在弧长 u 处插值中心线像素坐标 */
export function centerAt(
  cl: { x: number; y: number }[],
  laneTop: number,
  u: number
): { x: number; y: number } {
  if (cl.length === 0) return { x: 0, y: 0 };
  const ty = laneTop + u;
  if (ty <= cl[0]!.y) return { ...cl[0]! };
  if (ty >= cl[cl.length - 1]!.y) return { ...cl[cl.length - 1]! };
  let best = cl[0]!;
  for (let i = 0; i < cl.length - 1; i++) {
    const a = cl[i]!;
    const b = cl[i + 1]!;
    if (ty >= a.y && ty <= b.y) {
      const t = (ty - a.y) / (b.y - a.y || 1);
      best = { x: a.x + (b.x - a.x) * t, y: ty };
      break;
    }
  }
  return best;
}

/** 带拖尾的不对称强度 */
function bandIntensity(b: SynBand, du: number): number {
  if (b.tail && b.tail > 0 && du > 0) {
    return (
      b.amp *
      Math.exp(-(du * du) / (2 * (b.sigmaU * (1 + b.tail * (du / b.sigmaU))) ** 2))
    );
  }
  return b.amp * Math.exp(-(du * du) / (2 * b.sigmaU ** 2));
}

export interface GeneratedGel {
  raster: Raster;
  laneTop: number;
  laneBottom: number;
  centerlines: Record<string, { x: number; y: number }[]>;
  bandTruth: Record<
    string,
    { laneId: string; ordinal: number; x: number; y: number; u: number; spec: SynBand }[]
  >;
}

export function generateGel(spec: SynGelSpec): GeneratedGel {
  const r = makeRaster(spec.width, spec.height, spec.background);
  const rand = rng(spec.seed);
  const laneTop = 28;
  const laneBottom = spec.height - 28;
  const centerlines: GeneratedGel['centerlines'] = {};
  const bandTruth: GeneratedGel['bandTruth'] = {};

  for (const lane of spec.lanes) centerlines[lane.id] = laneCenterline(lane, laneTop, laneBottom);

  for (let y = 0; y < spec.height; y++) {
    for (let x = 0; x < spec.width; x++) {
      let v = spec.background + (rand() - 0.5) * spec.noiseAmp;
      for (const lane of spec.lanes) {
        const cl = centerlines[lane.id]!;
        // 找到该 y 对应的中心线 x（微笑后边界也是弯曲的）
        const c = centerAt(cl, laneTop, y - laneTop);
        const lateral = x - c.x;
        if (Math.abs(lateral) > lane.halfWidth + 8) continue;
        const lateralWin = Math.exp(-(lateral * lateral) / (2 * (lane.halfWidth * 0.42) ** 2));
        for (const b of lane.bands) {
          const du = y - (laneTop + b.u);
          v += bandIntensity(b, du) * lateralWin;
        }
      }
      setPx(r, x, y, v);
    }
  }

  for (const lane of spec.lanes) {
    const cl = centerlines[lane.id]!;
    bandTruth[lane.id] = lane.bands
      .map((b, ordinal) => {
        const c = centerAt(cl, laneTop, b.u);
        return { laneId: lane.id, ordinal: ordinal + 1, x: c.x, y: c.y, u: b.u, spec: b };
      })
      .sort((a, b2) => a.y - b2.y);
  }

  return { raster: r, laneTop, laneBottom, centerlines, bandTruth };
}
