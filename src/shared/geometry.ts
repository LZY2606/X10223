import type { PixelPos } from './types';

export function dist(a: PixelPos, b: PixelPos): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 沿折线的累计弧长（像素），每段返回到该顶点的距离 */
export function cumulativeArcLength(spine: PixelPos[]): number[] {
  const acc = [0];
  for (let i = 1; i < spine.length; i++) acc.push(acc[i - 1] + dist(spine[i - 1], spine[i]));
  return acc;
}

/** 点到脊柱的弧长投影：找到最近分段并投影，返回 s（像素） */
export function projectToSpine(p: PixelPos, spine: PixelPos[]): { s: number; point: PixelPos } {
  const acc = cumulativeArcLength(spine);
  let bestS = 0;
  let bestD = Infinity;
  let bestPoint: PixelPos = spine[0];
  for (let i = 0; i < spine.length - 1; i++) {
    const a = spine[i];
    const b = spine[i + 1];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + t * vx, y: a.y + t * vy };
    const d = Math.hypot(p.x - q.x, p.y - q.y);
    if (d < bestD) {
      bestD = d;
      bestS = acc[i] + t * (acc[i + 1] - acc[i]);
      bestPoint = q;
    }
  }
  return { s: bestS, point: bestPoint };
}

/** 给定弧长返回脊柱上的点（用于叠加绘制） */
export function pointAtS(spine: PixelPos[], s: number): PixelPos {
  const acc = cumulativeArcLength(spine);
  if (s <= 0) return spine[0];
  if (s >= acc[acc.length - 1]) return spine[spine.length - 1];
  for (let i = 0; i < acc.length - 1; i++) {
    if (s >= acc[i] && s <= acc[i + 1]) {
      const t = (s - acc[i]) / (acc[i + 1] - acc[i] || 1);
      return {
        x: spine[i].x + t * (spine[i + 1].x - spine[i].x),
        y: spine[i].y + t * (spine[i + 1].y - spine[i].y),
      };
    }
  }
  return spine[spine.length - 1];
}

/** 显示帧像素 -> 原始拍摄帧像素（撤销拍摄方向旋转） */
export function displayedToRaw(
  p: PixelPos,
  rotationCw: 0 | 90 | 180 | 270,
  dispW: number,
  dispH: number,
): PixelPos {
  switch (rotationCw) {
    case 0:
      return p;
    case 90:
      // 原图宽 = 显示高
      return { x: dispH - 1 - p.y, y: p.x };
    case 180:
      return { x: dispW - 1 - p.x, y: dispH - 1 - p.y };
    case 270:
      return { x: p.y, y: dispW - 1 - p.x };
  }
}

export function rotateSize(w: number, h: number, cw: 0 | 90 | 180 | 270) {
  return cw === 90 || cw === 270 ? { width: h, height: w } : { width: w, height: h };
}
