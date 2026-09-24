import type { PixelPoint } from "./types.js";

// ---------------------------------------------------------------------------
// 坐标基准：所有来源坐标保留 source_px；orientation 仅在显示层做刚体旋转。
// ---------------------------------------------------------------------------

/** source_px -> display_px（顺时针 clockwiseDeg）。 */
export function toDisplay(p: PixelPoint, w: number, h: number, deg: number): PixelPoint {
  switch (deg) {
    case 0:
      return { x: p.x, y: p.y };
    case 90:
      return { x: h - p.y, y: p.x };
    case 180:
      return { x: w - p.x, y: h - p.y };
    case 270:
      return { x: p.y, y: w - p.x };
  }
}

export function displaySize(w: number, h: number, deg: number): { w: number; h: number } {
  return deg === 90 || deg === 270 ? { w: h, h: w } : { w: w, h: h };
}

// ---------------------------------------------------------------------------
// 弯曲泳道：控制点定义自加样端出发的分段线性脊线。
// 迁移距离 = 沿脊线的弧长 s (px)。弯曲时「同一全局高度」≠「同一迁移距离」。
// ---------------------------------------------------------------------------

export interface Spine {
  cum: number[]; // 每段起点累计弧长
  pts: PixelPoint[];
  length: number;
}

export function buildSpine(points: PixelPoint[]): Spine {
  if (points.length < 2) throw new Error("泳道至少需要两个控制点");
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!;
    const b = points[i]!;
    cum.push(cum[i - 1]! + Math.hypot(b.x - a.x, b.y - a.y));
  }
  return { cum, pts: points.map((p) => ({ ...p })), length: cum[cum.length - 1]! };
}

/** 弧长 s -> 脊线上的点与切向。 */
export function spineAt(spine: Spine, s: number): { point: PixelPoint; tangent: PixelPoint } {
  const { cum, pts } = spine;
  const clamped = Math.max(0, Math.min(spine.length, s));
  for (let i = 1; i < cum.length; i++) {
    if (clamped <= cum[i]! || i === cum.length - 1) {
      const a = pts[i - 1]!;
      const b = pts[i]!;
      const segLen = cum[i]! - cum[i - 1]! || 1;
      const t = Math.max(0, Math.min(1, (clamped - cum[i - 1]!) / segLen));
      return {
        point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        tangent: { x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen },
      };
    }
  }
  const last = pts[pts.length - 1]!;
  return { point: { ...last }, tangent: { x: 0, y: 1 } };
}

/**
 * 把任意像素点投影到脊线，返回沿脊线迁移距离 s 与法向偏移 d。
 * 这是「微笑」弯曲场景的关键：用 s 而非全局 y 做分子量校准。
 */
export function projectToSpine(spine: Spine, p: PixelPoint): { s: number; offset: number } {
  let best = { s: 0, dist: Infinity, signed: 0 };
  for (let i = 1; i < spine.pts.length; i++) {
    const a = spine.pts[i - 1]!;
    const b = spine.pts[i]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1e-9;
    let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + vx * t;
    const qy = a.y + vy * t;
    const dist = Math.hypot(p.x - qx, p.y - qy);
    if (dist < best.dist) {
      const s = spine.cum[i - 1]! + t * (spine.cum[i]! - spine.cum[i - 1]!);
      // 法向符号：切线旋转 -90°
      const tx = vx / Math.sqrt(len2);
      const ty = vy / Math.sqrt(len2);
      const nx = ty;
      const ny = -tx;
      best = { s, dist, signed: (p.x - qx) * nx + (p.y - qy) * ny };
    }
  }
  return { s: best.s, offset: best.signed };
}

/** 脊线在弧长 s 处的法向单位向量。 */
export function normalAt(spine: Spine, s: number): PixelPoint {
  const { tangent } = spineAt(spine, s);
  return { x: tangent.y, y: -tangent.x };
}

/** 点是否落在泳道条带（半宽）内。 */
export function pointLiesOnLane(spine: Spine, p: PixelPoint, halfWidth: number): boolean {
  return Math.abs(projectToSpine(spine, p).offset) <= halfWidth;
}
