import type { PixelPoint } from './types';

export interface Pt {
  x: number;
  y: number;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 折线累计弧长（像素） */
export function arcLengths(points: Pt[]): number[] {
  const lens = [0];
  for (let i = 1; i < points.length; i++) {
    lens.push(lens[i - 1] + dist(points[i - 1], points[i]));
  }
  return lens;
}

export interface Projection {
  /** 投影点对应的弧长 t（像素） */
  t: number;
  /** 投影点坐标 */
  point: Pt;
  /** 点到曲线的垂直距离（像素，带符号：中心线右侧为正） */
  offsetPx: number;
  /** 所在折线段索引 */
  segmentIndex: number;
}

/** 把任意像素点投影到折线：返回弧长与横向偏移。弯曲泳道下，等 y 不再等 t。 */
export function projectToPolyline(point: Pt, points: PixelPoint[]): Projection {
  let best: Projection | null = null;
  let bestD = Infinity;
  let cum = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i];
    const b = points[i + 1];
    const segLen = dist(a, b);
    const ux = (b.x - a.x) / segLen;
    const uy = (b.y - a.y) / segLen;
    let f = ((point.x - a.x) * ux + (point.y - a.y) * uy) / segLen;
    f = Math.max(0, Math.min(1, f));
    const px = a.x + f * (b.x - a.x);
    const py = a.y + f * (b.y - a.y);
    const d = Math.hypot(point.x - px, point.y - py);
    if (d < bestD) {
      const cross = ux * (point.y - a.y) - uy * (point.x - a.x);
      bestD = d;
      best = {
        t: cum + f * segLen,
        point: { x: px, y: py },
        offsetPx: cross,
        segmentIndex: i
      };
    }
    cum += segLen;
  }
  if (!best) {
    return { t: 0, point: { ...points[0] }, offsetPx: 0, segmentIndex: 0 };
  }
  return best;
}

/**
 * 拍摄方向：把原图坐标变换到查看方向。
 * rotation90 = 相对原图顺时针旋转的 90° 次数；再做翻转。
 */
export function viewTransform(
  x: number,
  y: number,
  w: number,
  h: number,
  rotation90: 0 | 1 | 2 | 3,
  flipH: boolean,
  flipV: boolean
): Pt {
  let px = x;
  let py = y;
  let cw = w;
  let ch = h;
  for (let k = 0; k < rotation90; k++) {
    const nx = ch - py;
    const ny = px;
    px = nx;
    py = ny;
    const t = cw;
    cw = ch;
    ch = t;
  }
  if (flipH) px = cw - px;
  if (flipV) py = ch - py;
  return { x: px, y: py };
}

/** 逆变换：查看方向坐标 -> 原图坐标（人工在叠加层修订后仍保留像素级来源） */
export function originalFromView(
  x: number,
  y: number,
  w: number,
  h: number,
  rotation90: 0 | 1 | 2 | 3,
  flipH: boolean,
  flipV: boolean
): Pt {
  // 求最终查看图尺寸
  let vw = w;
  let vh = h;
  if (rotation90 === 1 || rotation90 === 3) {
    vw = h;
    vh = w;
  }
  let px = x;
  let py = y;
  if (flipH) px = vw - px;
  if (flipV) py = vh - py;
  // 逆时针旋转 rotation90 次
  let cw = vw;
  let ch = vh;
  for (let k = 0; k < rotation90; k++) {
    const nx = py;
    const ny = cw - px;
    px = nx;
    py = ny;
    const t = cw;
    cw = ch;
    ch = t;
  }
  return { x: px, y: py };
}

/** 旋转整张灰度图（顺时针 90*rotation90），返回新缓冲与尺寸 */
export function rotateGray(
  gray: Uint8Array,
  w: number,
  h: number,
  rotation90: 0 | 1 | 2 | 3
): { gray: Uint8Array; width: number; height: number } {
  if (rotation90 === 0) return { gray, width: w, height: h };
  if (rotation90 === 2) {
    const out = new Uint8Array(w * h);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) out[(h - 1 - y) * w + (w - 1 - x)] = gray[y * w + x];
    }
    return { gray: out, width: w, height: h };
  }
  const nw = h;
  const nh = w;
  const out = new Uint8Array(nw * nh);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const v = gray[y * w + x];
      if (rotation90 === 1) out[x * nw + (nw - 1 - y)] = v;
      else out[(nh - 1 - x) * nw + y] = v;
    }
  }
  return { gray: out, width: nw, height: nh };
}

/** 估计泳道中心线“微笑”弯曲量：两端点连线与中心线的最大偏离（像素） */
export function bendAmount(points: PixelPoint[]): number {
  if (points.length < 2) return 0;
  const a = points[0];
  const b = points[points.length - 1];
  const len = dist(a, b);
  if (len === 0) return 0;
  let maxD = 0;
  for (const p of points) {
    const f = ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (len * len);
    const qx = a.x + f * (b.x - a.x);
    const qy = a.y + f * (b.y - a.y);
    maxD = Math.max(maxD, Math.hypot(p.x - qx, p.y - qy));
  }
  return maxD;
}

/** 生成弯曲中心线：在直线基础上叠加二次“微笑”偏移（像素） */
export function smilingCenterline(
  xCenter: number,
  yTop: number,
  yBottom: number,
  bendPx: number,
  samples = 40
): PixelPoint[] {
  const pts: PixelPoint[] = [];
  for (let i = 0; i <= samples; i++) {
    const f = i / samples;
    const y = yTop + f * (yBottom - yTop);
    const x = xCenter + bendPx * 4 * f * (1 - f);
    pts.push({ x, y, frame: 'original' });
  }
  return pts;
}
