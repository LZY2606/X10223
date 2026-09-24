import type { PixelPoint, XY } from "./types.js";

export function dist(a: XY, b: XY): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 折线点列 → 弧长参数（累计长度） */
export function arcLengths(points: XY[]): number[] {
  const s = [0];
  for (let i = 1; i < points.length; i++) {
    s.push(s[i - 1] + dist(points[i - 1], points[i]));
  }
  return s;
}

export interface SampledCurve {
  points: XY[];
  s: number[];
  total: number;
}

export function sampleCurve(points: PixelPoint[], step = 1): SampledCurve {
  if (points.length < 2) {
    return {
      points: points.map((p) => ({ x: p.x, y: p.y })),
      s: [0],
      total: 0
    };
  }
  const segLen: number[] = [];
  for (let i = 1; i < points.length; i++) segLen.push(dist(points[i - 1], points[i]));
  const total = segLen.reduce((a, b) => a + b, 0);
  const out: XY[] = [];
  const sOut: number[] = [];
  const n = Math.max(1, Math.round(total / step));
  let seg = 0;
  let segStart = 0;
  for (let i = 0; i <= n; i++) {
    const target = (total * i) / n;
    while (
      seg < segLen.length - 1 &&
      segStart + segLen[seg] < target - 1e-9
    ) {
      segStart += segLen[seg];
      seg++;
    }
    const t = segLen[seg] === 0 ? 0 : (target - segStart) / segLen[seg];
    const p0 = points[seg];
    const p1 = points[seg + 1];
    out.push({
      x: p0.x + (p1.x - p0.x) * t,
      y: p0.y + (p1.y - p0.y) * t
    });
    sOut.push(target);
  }
  return { points: out, s: sOut, total };
}

/** 在折线上按弧长 s 求点与局部切线角 */
export function pointAt(points: PixelPoint[], s: number): { point: XY; tangent: XY } {
  if (points.length === 1) {
    return { point: { x: points[0].x, y: points[0].y }, tangent: { x: 0, y: 1 } };
  }
  const lens = arcLengths(points);
  const total = lens[lens.length - 1];
  const target = Math.min(Math.max(s, 0), total);
  for (let i = 1; i < points.length; i++) {
    if (lens[i] >= target - 1e-9) {
      const segLen = lens[i] - lens[i - 1];
      const t = segLen === 0 ? 0 : (target - lens[i - 1]) / segLen;
      const p0 = points[i - 1];
      const p1 = points[i];
      const dx = p1.x - p0.x;
      const dy = p1.y - p0.y;
      const norm = Math.hypot(dx, dy) || 1;
      return {
        point: {
          x: p0.x + dx * t,
          y: p0.y + dy * t
        },
        tangent: { x: dx / norm, y: dy / norm }
      };
    }
  }
  const last = points[points.length - 1];
  return { point: { x: last.x, y: last.y }, tangent: { x: 0, y: 1 } };
}

export function bilinear(
  raster: { pixels: Uint8Array; width: number; height: number },
  x: number,
  y: number
): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const fx = x - x0;
  const fy = y - y0;
  const at = (xx: number, yy: number): number => {
    const cx = Math.min(raster.width - 1, Math.max(0, xx));
    const cy = Math.min(raster.height - 1, Math.max(0, yy));
    return raster.pixels[cy * raster.width + cx];
  };
  const v00 = at(x0, y0);
  const v10 = at(x0 + 1, y0);
  const v01 = at(x0, y0 + 1);
  const v11 = at(x0 + 1, y0 + 1);
  return (
    v00 * (1 - fx) * (1 - fy) +
    v10 * fx * (1 - fy) +
    v01 * (1 - fx) * fy +
    v11 * fx * fy
  );
}

/** 沿曲线法线方向对宽度 [−w,+w] 求平均，得到沿 s 的一维投影 */
export function profileAlong(
  raster: { pixels: Uint8Array; width: number; height: number },
  points: PixelPoint[],
  halfWidth: number,
  step = 1
): { s: number; intensity: number; point: XY }[] {
  const sampled = sampleCurve(points, step);
  const result: { s: number; intensity: number; point: XY }[] = [];
  for (let i = 0; i < sampled.points.length; i++) {
    const p = sampled.points[i];
    const s = sampled.s[i];
    const { tangent } = pointAt(points, s);
    const nx = -tangent.y;
    const ny = tangent.x;
    let sum = 0;
    let count = 0;
    for (let w = -halfWidth; w <= halfWidth; w++) {
      sum += bilinear(raster, p.x + nx * w, p.y + ny * w);
      count++;
    }
    result.push({ s, intensity: sum / count, point: p });
  }
  return result;
}
