import type { Point } from './types.js';

// ---- 基础几何（全部显式像素坐标） ----

export function dist(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 折线/样条的逐段长度与累积弧长 */
export function arcLengthTable(points: Point[]): { cum: number[]; segs: number[] } {
  const cum = [0];
  const segs: number[] = [];
  for (let i = 1; i < points.length; i++) {
    const d = dist(points[i - 1]!, points[i]!);
    segs.push(d);
    cum.push(cum[i - 1]! + d);
  }
  return { cum, segs };
}

/** 在折线上按弧长取点（“微笑”弯曲后，同一 y 高度不等于同一弧长） */
export function pointAtArc(points: Point[], s: number): { point: Point; segIndex: number } {
  const { cum, segs } = arcLengthTable(points);
  const total = cum[cum.length - 1]!;
  const clamped = Math.max(0, Math.min(total, s));
  for (let i = 0; i < segs.length; i++) {
    if (clamped <= cum[i + 1]!) {
      const segLen = segs[i]! || 1;
      const t = (clamped - cum[i]!) / segLen;
      const a = points[i]!;
      const b = points[i + 1]!;
      return { point: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t }, segIndex: i };
    }
  }
  return { point: points[points.length - 1]!, segIndex: segs.length - 1 };
}

/** 点到折线的弧长投影（最近点），返回沿中心线弧长 */
export function projectToCurve(points: Point[], p: Point): { arc: number; pixel: Point } {
  let best = { arc: 0, d: Infinity, pixel: points[0]! };
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i]!;
    const b = points[i + 1]!;
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
    const q = { x: a.x + vx * t, y: a.y + vy * t };
    const d = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    if (d < best.d) {
      const { cum } = arcLengthTable(points);
      best = { arc: cum[i]! + Math.hypot(q.x - a.x, q.y - a.y), d, pixel: q };
    }
  }
  return { arc: best.arc, pixel: best.pixel };
}

/** 用二次多项式拟合中心线 x = a + b*y + c*y^2（泳道弯曲/smile 模型） */
export function fitQuadraticCenterline(
  ys: number[],
  xs: number[],
): { a: number; b: number; c: number; sample: (y: number) => Point } {
  const n = ys.length;
  let sx = 0, sy = 0, sy2 = 0, sy3 = 0, sy4 = 0, sxy = 0, sx2y = 0;
  for (let i = 0; i < n; i++) {
    const x = xs[i]!;
    const y = ys[i]!;
    sx += x; sy += y; sy2 += y * y; sy3 += y * y * y; sy4 += y * y * y * y;
    sxy += x * y; sx2y += x * y * y;
  }
  // 解 3x3 正规方程
  const M = [
    [n, sy, sy2],
    [sy, sy2, sy3],
    [sy2, sy3, sy4],
  ];
  const rhs = [sx, sxy, sx2y];
  const [a, b, c] = solve3(M, rhs);
  return { a, b, c, sample: (y: number) => ({ x: a + b * y + c * y * y, y }) };
}

function solve3(M: number[][], r: number[]): [number, number, number] {
  const A = M.map((row, i) => [...row, r[i]!]);
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let k = col + 1; k < 3; k++) if (Math.abs(A[k]![col]!) > Math.abs(A[piv]![col]!)) piv = k;
    [A[col], A[piv]] = [A[piv]!, A[col]!];
    const d = A[col]![col]! || 1e-12;
    for (let k = 0; k < 3; k++) {
      if (k === col) continue;
      const f = A[k]![col]! / d;
      for (let j = col; j < 4; j++) A[k]![j] = A[k]![j]! - f * A[col]![j]!;
    }
  }
  return [A[0]![3]! / A[0]![0]!, A[1]![3]! / A[1]![1]!, A[2]![3]! / A[2]![2]!];
}

/** 由中心线与半宽生成左右边界 */
export function boundariesFromCenter(
  center: Point[],
  halfWidth: number,
): { left: Point[]; right: Point[] } {
  const left: Point[] = [];
  const right: Point[] = [];
  for (let i = 0; i < center.length; i++) {
    const p = center[i]!;
    const prev = center[Math.max(0, i - 1)]!;
    const next = center[Math.min(center.length - 1, i + 1)]!;
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    const len = Math.hypot(dx, dy) || 1;
    const nx = -dy / len;
    left.push({ x: p.x + nx * halfWidth, y: p.y });
    right.push({ x: p.x - nx * halfWidth, y: p.y });
  }
  return { left, right };
}

// ---- 拍摄方向：旋转映射（保留像素级来源） ----

export function rotatePoint(p: Point, deg: 0 | 90 | 180 | 270, w: number, h: number): Point {
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

export function frameDims(w: number, h: number, deg: 0 | 90 | 180 | 270): { w: number; h: number } {
  return deg === 90 || deg === 270 ? { w: h, h: w } : { w, h };
}

/** 椭圆轮廓采样（合成条带轮廓，供叠加显示与残差证据） */
export function ellipseContour(
  center: Point,
  rx: number,
  ry: number,
  n = 24,
  skew = 0,
): Point[] {
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    const t = (i / n) * Math.PI * 2;
    out.push({
      x: center.x + rx * Math.cos(t),
      y: center.y + ry * Math.sin(t) + skew * Math.cos(t),
    });
  }
  return out;
}

export function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
