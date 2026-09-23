import { encodeGrayPng } from "./png.js";
import type { Point } from "./types.js";

/**
 * 离线领域案例包：合成但像素级真实的凝胶图像。
 * 坐标系：upright 空间，迁移方向自上而下，x 向右。
 */

export const GEL_W = 480;
export const GEL_H = 560;
export const LANE_TOP = 40;
export const LANE_BOTTOM = 520;
export const LANE_HALF_WIDTH = 26;

export const LADDER_BP = [1500, 1000, 750, 500, 250, 100];

export interface GenBand {
  id: string;
  laneId: string;
  /** 沿 lane 弧长的迁移位置（px，自 LANE_TOP） */
  s: number;
  sigmaPx: number;
  /** 峰值强度 0..1；>0.985 形成饱和平台 */
  amp: number;
  /** 拖尾：向下延长的非对称尾部（px） */
  smearTailPx?: number;
}

export interface GenLane {
  laneId: string;
  role: "sample" | "ladder";
  centerX: number;
  /** “微笑”弯曲幅度（px）：中部沿法向偏移 */
  bow?: number;
}

export interface GelSpec {
  lanes: GenLane[];
  bands: GenBand[];
  /** 原图相对 upright 的顺时针旋转角 */
  rotateDeg: 0 | 90 | 180 | 270;
  noise?: number;
}

/** bp → 弧长迁移位置（log10 线性，校准真值） */
export function bpToS(bp: number): number {
  const sTop = 40; // 1500bp
  const sBottom = 360; // 100bp
  const f =
    (Math.log10(1500) - Math.log10(bp)) / (Math.log10(1500) - Math.log10(100));
  return sTop + f * (sBottom - sTop);
}
export function sToBp(s: number): number {
  const sTop = 40;
  const sBottom = 360;
  const f = (s - sTop) / (sBottom - sTop);
  return 10 ** (Math.log10(1500) - f * (Math.log10(1500) - Math.log10(100)));
}

/** lane 中心线在弧长 s 处的 upright 坐标 */
export function spinePoint(lane: GenLane, s: number): { x: number; y: number; nx: number; ny: number } {
  const f = (s - 0) / (LANE_BOTTOM - LANE_TOP);
  const bend = lane.bow ?? 0;
  // 真弯曲：x 随弧长正弦偏移，y 带“微笑”下垂
  const x = lane.centerX + bend * Math.sin(Math.PI * f);
  const y = LANE_TOP + s + bend * 0.6 * Math.sin(Math.PI * f) * 0;
  // 切向/法向（解析导数）
  const dxdS = (bend * Math.PI * Math.cos(Math.PI * f)) / (LANE_BOTTOM - LANE_TOP);
  const dydS = 1;
  const tLen = Math.hypot(dxdS, dydS);
  return { x, y, nx: -dydS / tLen, ny: dxdS / tLen };
}

/** 沿 lane 折线采样的边界点（px 级几何真值） */
export function laneBoundaryPoints(lane: GenLane, side: -1 | 1, samples = 40): Point[] {
  const pts: Point[] = [];
  for (let i = 0; i <= samples; i++) {
    const s = ((LANE_BOTTOM - LANE_TOP) * i) / samples;
    const sp = spinePoint(lane, s);
    pts.push({
      x: { value: sp.x + side * sp.nx * LANE_HALF_WIDTH, unit: "px", frame: "upright" },
      y: { value: sp.y + side * sp.ny * LANE_HALF_WIDTH, unit: "px", frame: "upright" },
    });
  }
  return pts;
}

export function bandCenterPoint(lane: GenLane, s: number): Point {
  const sp = spinePoint(lane, s);
  return {
    x: { value: sp.x, unit: "px", frame: "upright" },
    y: { value: sp.y, unit: "px", frame: "upright" },
  };
}

function rotateGrayCW(
  gray: Uint8Array,
  w: number,
  h: number,
  deg: 0 | 90 | 180 | 270
): { gray: Uint8Array; w: number; h: number } {
  if (deg === 0) return { gray, w, h };
  const nw = deg === 90 || deg === 270 ? h : w;
  const nh = deg === 90 || deg === 270 ? w : h;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let nx = x;
      let ny = y;
      if (deg === 90) {
        nx = h - 1 - y;
        ny = x;
      } else if (deg === 180) {
        nx = w - 1 - x;
        ny = h - 1 - y;
      } else {
        nx = y;
        ny = w - 1 - x;
      }
      out[ny * nw + nx] = gray[y * w + x];
    }
  }
  return { gray: out, w: nw, h: nh };
}

/** 将 upright 帧点变换到 raw（旋转后）帧 */
export function uprightToRaw(
  x: number,
  y: number,
  deg: 0 | 90 | 180 | 270,
  upW = GEL_W,
  upH = GEL_H
): { x: number; y: number } {
  // rotateGrayCW 的逆：raw = rotateCW(upright, 360-deg)
  const d = ((360 - deg) % 360) as 0 | 90 | 180 | 270;
  const rw = d === 90 || d === 270 ? upH : upW;
  const rh = d === 90 || d === 270 ? upW : upH;
  if (d === 0) return { x, y };
  if (d === 90) return { x: upH - 1 - y, y: x };
  if (d === 180) return { x: upW - 1 - x, y: upH - 1 - y };
  return { x: y, y: upW - 1 - x };
}

export function renderGel(spec: GelSpec): { png: Uint8Array; width: number; height: number } {
  const gray = new Uint8Array(GEL_W * GEL_H).fill(28);
  const noise = spec.noise ?? 3;
  // 背景
  for (let i = 0; i < gray.length; i++) gray[i] = 30 + ((i * 1103515245 + 12345) % noise);
  const laneById = new Map(spec.lanes.map((l) => [l.laneId, l]));

  for (const band of spec.bands) {
    const lane = laneById.get(band.laneId)!;
    const s0 = band.s;
    for (let s = s0 - 4 * band.sigmaPx - (band.smearTailPx ?? 0) - 2; s < s0 + 4 * band.sigmaPx + 2; s++) {
      if (s < 0 || s > LANE_BOTTOM - LANE_TOP) continue;
      const sp = spinePoint(lane, s);
      const along = s - s0;
      const alongG = Math.exp(-(along * along) / (2 * band.sigmaPx * band.sigmaPx));
      const smear =
        band.smearTailPx && along > 0
          ? Math.exp(-along / band.smearTailPx) * 0.5
          : 0;
      const strength = Math.max(alongG, along > 0 ? smear : 0);
      if (strength <= 0.01) continue;
      for (let t = -LANE_HALF_WIDTH - 2; t <= LANE_HALF_WIDTH + 2; t++) {
        const transverse = Math.exp(-(t * t) / (2 * 10 * 10));
        const px = sp.x + sp.nx * t;
        const py = sp.y + sp.ny * t;
        const ix = Math.round(px);
        const iy = Math.round(py);
        if (ix < 0 || iy < 0 || ix >= GEL_W || iy >= GEL_H) continue;
        const add = 255 * band.amp * strength * transverse;
        const v = Math.min(255, gray[iy * GEL_W + ix] + add);
        gray[iy * GEL_W + ix] = v;
      }
    }
  }
  const rot = rotateGrayCW(gray, GEL_W, GEL_H, spec.rotateDeg);
  return { png: encodeGrayPng(rot.w, rot.h, rot.gray), width: rot.w, height: rot.h };
}
