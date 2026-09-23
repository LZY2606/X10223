import type { ImageMaterial, Polyline, Vec2, PixelSource } from './types.js';
import { diagnostic } from './diagnostics.js';
import type { Diagnostic } from './types.js';

export const v = (x: number, y: number): Vec2 => ({ x, y });

export function distanceXy(a: Vec2, b: Vec2): number {
  return Math.hypot(b.x - a.x, b.y - a.y);
}

/** 毫米距离：需要图像的像素间距。 */
export function distanceMm(a: Vec2, b: Vec2, image: ImageMaterial): number {
  const dx = (b.x - a.x) * image.pixelSpacing.x;
  const dy = (b.y - a.y) * image.pixelSpacing.y;
  return Math.hypot(dx, dy);
}

/** 沿折线的逐段累积弧长（mm）。 */
export function cumulativeArcMm(polyline: Polyline, image: ImageMaterial): number[] {
  const acc = [0];
  for (let i = 1; i < polyline.points.length; i++) {
    acc.push(acc[i - 1] + distanceMm(polyline.points[i - 1], polyline.points[i], image));
  }
  return acc;
}

export function totalArcMm(polyline: Polyline, image: ImageMaterial): number {
  const acc = cumulativeArcMm(polyline, image);
  return acc[acc.length - 1];
}

/** 在弧长 s(mm) 处取折线上的点。 */
export function pointAtArcMm(polyline: Polyline, image: ImageMaterial, sMm: number): { point: Vec2; tangent: Vec2; normal: Vec2 } {
  const pts = polyline.points;
  const acc = cumulativeArcMm(polyline, image);
  const total = acc[acc.length - 1];
  const s = Math.max(0, Math.min(total, sMm));
  let seg = 0;
  while (seg < acc.length - 2 && acc[seg + 1] < s) seg++;
  const segLen = acc[seg + 1] - acc[seg] || 1e-9;
  const t = (s - acc[seg]) / segLen;
  const p0 = pts[seg];
  const p1 = pts[seg + 1];
  const point = { x: p0.x + (p1.x - p0.x) * t, y: p0.y + (p1.y - p0.y) * t };
  const tangent = { x: (p1.x - p0.x) / segLen, y: (p1.y - p0.y) / segLen };
  const normal = { x: -tangent.y, y: tangent.x };
  return { point, tangent, normal };
}

/**
 * 将一个像素点投影到泳道中心线上：返回弧长 s(mm) 与横向偏移（mm）。
 * “微笑”弯曲时，同一张图上 y 相同的两个点，落在不同弯的泳道上，s 可以不同。
 */
export function projectToLane(
  centerline: Polyline,
  image: ImageMaterial,
  p: Vec2,
): { sMm: number; lateralMm: number; pointOnLine: Vec2 } {
  let best: { sMm: number; lateralMm: number; pointOnLine: Vec2 } | null = null;
  let bestD2 = Infinity;
  const acc = cumulativeArcMm(centerline, image);
  for (let i = 0; i < centerline.points.length - 1; i++) {
    const a = centerline.points[i];
    const b = centerline.points[i + 1];
    const segLenPx = distanceXy(a, b) || 1e-9;
    const tx = (b.x - a.x) / segLenPx;
    const ty = (b.y - a.y) / segLenPx;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * tx + (p.y - a.y) * ty) / segLenPx));
    const q = { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
    const d2 = (p.x - q.x) ** 2 + (p.y - q.y) ** 2;
    if (d2 < bestD2) {
      bestD2 = d2;
      const segLenMm = acc[i + 1] - acc[i] || 1e-9;
      const sMm = acc[i] + segLenMm * t;
      const nx = -ty;
      const ny = tx;
      const lateralMm =
        (p.x - q.x) * nx * image.pixelSpacing.x + (p.y - q.y) * ny * image.pixelSpacing.y;
      best = { sMm, lateralMm, pointOnLine: q };
    }
  }
  return best!;
}

/** Chaikin 平滑：把折线变成平滑泳道曲线（用于“微笑”弯曲）。 */
export function smoothChaikin(polyline: Polyline, iterations = 2): Polyline {
  let pts = polyline.points;
  for (let it = 0; it < iterations; it++) {
    const out: Vec2[] = [pts[0]];
    for (let i = 0; i < pts.length - 1; i++) {
      const p0 = pts[i];
      const p1 = pts[i + 1];
      out.push({ x: p0.x * 0.75 + p1.x * 0.25, y: p0.y * 0.75 + p1.y * 0.25 });
      out.push({ x: p0.x * 0.25 + p1.x * 0.75, y: p0.y * 0.25 + p1.y * 0.75 });
    }
    out.push(pts[pts.length - 1]);
    pts = out;
  }
  return { frame: polyline.frame, points: pts };
}

export function makePolyline(frame: string, points: Vec2[]): Polyline {
  return { frame, points };
}

/** 检查折线坐标基准是否匹配图像，否则产生带位置诊断。 */
export function assertFrame(
  polyline: Polyline,
  imageId: string,
  ctx: { materialId: string; path: string },
): Diagnostic[] {
  if (polyline.frame !== imageId) {
    return [
      diagnostic('COORDINATE_FRAME_MISMATCH', 'error', `折线坐标基准 ${polyline.frame} 与图像 ${imageId} 不一致`, {
        materialId: ctx.materialId,
        path: ctx.path,
      }),
    ];
  }
  return [];
}

export function pixelSourceToVec2(s: PixelSource): Vec2 {
  return { x: s.x, y: s.y };
}
