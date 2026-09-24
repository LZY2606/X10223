// 离线领域材料：确定性合成凝胶（不依赖通用表格）。
// 可复现地生成“微笑”弯曲泳道、饱和平台、拖尾、重叠双带、ladder 缺带等像素证据。
import type { RasterContent, Vec2 } from "./types";

export interface GenBand {
  /** 沿 lane 弧长的位置（像素，从点样孔起）；与 sFrac 二选一 */
  sPx?: number;
  sFrac?: number;
  amp: number;
  sigmaS: number;
  /** 拖尾长度（像素，向迁移方向拖尾），0 表示无 */
  tail?: number;
  label?: string;
}

export interface GenLane {
  label: string;
  role: "ladder" | "sample";
  xTopFrac: number;
  bands: GenBand[];
}

export interface GelGenSpec {
  width: number;
  height: number;
  wellsY: number;
  bottomMargin: number;
  laneHalfWidth: number;
  /** “微笑”幅度（像素）：边缘与中央泳道的迁移弧长-像素偏移差 */
  smile: number;
  /** 泳道横向弯曲幅度（像素） */
  bend: number;
  bg: number;
  noise: number;
  seed: number;
  lanes: GenLane[];
  /** 预旋转光栅（模拟拍摄方向错误，需 orientation 材料纠正） */
  preRotate?: 0 | 1 | 2 | 3;
}

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

/** 生成 lane 中心线控制点（解释帧）。微笑：弧长相同但像素 y 随泳道位置偏移。 */
export function laneCenterPoints(spec: GelGenSpec, laneIndex: number): Vec2[] {
  const n = spec.lanes.length;
  const edgeFactor = n === 1 ? 0 : (2 * Math.abs(spec.lanes[laneIndex].xTopFrac - 0.5)) / 0.5 - 1;
  const xTop = spec.lanes[laneIndex].xTopFrac * spec.width;
  const usable = spec.height - spec.wellsY - spec.bottomMargin;
  const pts: Vec2[] = [];
  const STEPS = 40;
  for (let i = 0; i <= STEPS; i++) {
    const s = (usable * i) / STEPS;
    const t = i / STEPS;
    const y = spec.wellsY + s + spec.smile * edgeFactor * Math.sin(Math.PI * t);
    const x = xTop + spec.bend * edgeFactor * Math.sin(Math.PI * t);
    pts.push({ x, y });
  }
  return pts;
}

function sample(curve: Vec2[], s: number): Vec2 {
  const segLen: number[] = [0];
  for (let i = 1; i < curve.length; i++) segLen.push(segLen[i - 1] + Math.hypot(curve[i].x - curve[i - 1].x, curve[i].y - curve[i - 1].y));
  const total = segLen[segLen.length - 1];
  if (s <= 0) return curve[0];
  if (s >= total) return curve[curve.length - 1];
  let i = 1;
  while (segLen[i] < s) i++;
  const f = (s - segLen[i - 1]) / (segLen[i] - segLen[i - 1] || 1);
  return {
    x: curve[i - 1].x + (curve[i].x - curve[i - 1].x) * f,
    y: curve[i - 1].y + (curve[i].y - curve[i - 1].y) * f
  };
}

export function usableLength(spec: GelGenSpec): number {
  return spec.height - spec.wellsY - spec.bottomMargin;
}

export function generateGel(spec: GelGenSpec): RasterContent {
  const w = spec.width;
  const h = spec.height;
  const g = new Float32Array(w * h);
  const usable = usableLength(spec);
  const curves = spec.lanes.map((_, i) => laneCenterPoints(spec, i));

  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      // 轻微背景梯度
      g[y * w + x] = spec.bg + 4 * (y / h);
    }
  }

  curves.forEach((curve, li) => {
    const lane = spec.lanes[li];
    const segLen: number[] = [0];
    for (let i = 1; i < curve.length; i++) segLen.push(segLen[i - 1] + Math.hypot(curve[i].x - curve[i - 1].x, curve[i].y - curve[i - 1].y));
    for (const band of lane.bands) {
      const s0 = band.sPx ?? (band.sFrac ?? 0) * usable;
      const reach = Math.min(usable, s0 + (band.tail ?? 0)) + 4 * band.sigmaS + 4;
      const sStart = Math.max(0, s0 - 4 * band.sigmaS);
      const STEPS = Math.ceil((reach - sStart) * 2);
      for (let si = 0; si <= STEPS; si++) {
        const s = sStart + ((reach - sStart) * si) / STEPS;
        const center = sample(curve, s);
        const ds = s - s0;
        let along = band.amp * Math.exp(-(ds * ds) / (2 * band.sigmaS * band.sigmaS));
        if (band.tail && ds > 0) along += band.amp * 0.55 * Math.exp(-ds / band.tail);
        if (along < 0.5) continue;
        const sigmaX = spec.laneHalfWidth * 0.42;
        const x0 = Math.max(0, Math.floor(center.x - spec.laneHalfWidth));
        const x1 = Math.min(w - 1, Math.ceil(center.x + spec.laneHalfWidth));
        const y0 = Math.max(0, Math.floor(center.y - 3 * band.sigmaS));
        const y1 = Math.min(h - 1, Math.ceil(center.y + 3 * band.sigmaS));
        for (let y = y0; y <= y1; y++) {
          for (let x = x0; x <= x1; x++) {
            const lateral = Math.exp(-((x - center.x) ** 2) / (2 * sigmaX * sigmaX));
            g[y * w + x] += along * lateral;
          }
        }
      }
      void segLen;
    }
  });

  const rand = mulberry32(spec.seed);
  let saturated = false;
  const out = new Uint8Array(new ArrayBuffer(w * h));
  for (let i = 0; i < g.length; i++) {
    const noisy = g[i] + (rand() - 0.5) * spec.noise;
    const v = Math.max(0, Math.min(255, Math.round(noisy)));
    if (v >= 255) saturated = true;
    out[i] = v;
  }

  const turns: 0 | 1 | 2 | 3 = spec.preRotate ?? 0;
  const rotated = turns ? rotateGrayscale(out, w, h, turns) : out;
  return { width: turns % 2 === 1 ? h : w, height: turns % 2 === 1 ? w : h, grayscale: rotated, saturated };
}

export function rotateGrayscale(src: Uint8Array, w: number, h: number, turns: 0 | 1 | 2 | 3): Uint8Array {
  if (turns === 0) return src;
  const swap = turns % 2 === 1;
  const ow = swap ? h : w;
  const oh = swap ? w : h;
  const dst = new Uint8Array(ow * oh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx = x;
      let ny = y;
      if (turns === 1) {
        nx = h - 1 - y;
        ny = x;
      } else if (turns === 2) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      dst[ny * ow + nx] = src[y * w + x];
    }
  }
  return dst;
}
