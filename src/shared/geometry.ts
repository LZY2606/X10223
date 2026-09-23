import type { Pt } from './types.ts';

/** 折线总长度（像素） */
export function polylineLength(pts: Pt[]): number {
  let len = 0;
  for (let i = 1; i < pts.length; i++) len += dist(pts[i - 1], pts[i]);
  return len;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 以固定弧长步长重采样折线 */
export function resampleByArc(pts: Pt[], stepPx: number): Pt[] {
  if (pts.length < 2 || stepPx <= 0) return pts.map((p) => ({ ...p }));
  const out: Pt[] = [{ ...pts[0] }];
  let consumed = 0; // 从当前折线起点累计的长度
  let segStart = pts[0];
  let nextTarget = stepPx; // 下一个采样点距折线起点的弧长
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = dist(a, b);
    const segEnd = consumed + segLen;
    const ux = segLen === 0 ? 0 : (b.x - a.x) / segLen;
    const uy = segLen === 0 ? 0 : (b.y - a.y) / segLen;
    while (nextTarget <= segEnd + 1e-9) {
      const t = (nextTarget - consumed) / (segLen || 1);
      out.push({ x: a.x + ux * (t * segLen), y: a.y + uy * (t * segLen) });
      nextTarget += stepPx;
    }
    consumed = segEnd;
    segStart = b;
  }
  void segStart;
  const end = pts[pts.length - 1];
  if (dist(out[out.length - 1], end) > 1e-6) out.push({ ...end });
  return out;
}


/**
 * 把像素点投影到折线：返回弧长 s 与最近点。
 * 这是“微笑弯曲使同一高度不等于同一分子量”的关键 —— 沿曲线量迁移距离。
 */
export function projectToPolyline(p: Pt, pts: Pt[]): { s: number; nearest: Pt; lateral: number } {
  let best = { s: 0, d: Infinity, nearest: pts[0], lateral: 0 };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy;
    let t = len2 === 0 ? 0 : ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2;
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + t * vx, y: a.y + t * vy };
    const d = dist(p, q);
    if (d < best.d) {
      // 横向偏移：点到折线的有符号距离（按中心线法向近似）
      const lateral = signedLateral(p, a, b);
      best = { s: acc + t * Math.sqrt(len2), d, nearest: q, lateral };
    }
    acc += Math.sqrt(len2);
  }
  return { s: best.s, nearest: best.nearest, lateral: best.lateral };
}

function signedLateral(p: Pt, a: Pt, b: Pt): number {
  const vx = b.x - a.x;
  const vy = b.y - a.y;
  const len = Math.hypot(vx, vy) || 1;
  // 法向（指向右侧）
  const nx = vy / len;
  const ny = -vx / len;
  return (p.x - a.x) * nx + (p.y - a.y) * ny;
}

/** 对曲线做平滑（用于 lane 中心线检测） */
export function smoothPts(pts: Pt[], window: number): Pt[] {
  if (window <= 1 || pts.length < 3) return pts;
  const half = Math.floor(window / 2);
  return pts.map((_, i) => {
    let sx = 0;
    let sy = 0;
    let n = 0;
    for (let k = -half; k <= half; k++) {
      const q = pts[i + k];
      if (q) {
        sx += q.x;
        sy += q.y;
        n++;
      }
    }
    return { x: sx / n, y: sy / n };
  });
}

/** 旋转 90/180/270 度后的坐标（图像坐标基准，左上原点） */
export function rotatePoint(p: Pt, deg: 0 | 90 | 180 | 270, w: number, h: number): Pt {
  switch (deg) {
    case 0:
      return { ...p };
    case 90:
      return { x: h - p.y, y: p.x };
    case 180:
      return { x: w - p.x, y: h - p.y };
    case 270:
      return { x: p.y, y: w - p.x };
  }
}
