// 几何：泳道曲线弧长、局部标尺有效区域、拍摄方向（旋转）坐标变换。
import type { Polyline, SourcedPoint, ValidRegion } from './types.js';

export interface Pt {
  x: number;
  y: number;
}

export function polylineSegments(line: Polyline | Pt[]): Array<[Pt, Pt]> {
  const pts = line as Pt[];
  const out: Array<[Pt, Pt]> = [];
  for (let i = 0; i < pts.length - 1; i++) out.push([pts[i]!, pts[i + 1]!]);
  return out;
}

export function arcLengthAt(line: Polyline | Pt[], endIndex?: number): number {
  const pts = line as Pt[];
  const stop = endIndex === undefined ? pts.length - 1 : endIndex;
  let len = 0;
  for (let i = 0; i < stop; i++) {
    len += Math.hypot(pts[i + 1]!.x - pts[i]!.x, pts[i + 1]!.y - pts[i]!.y);
  }
  return len;
}

export interface ArcSample {
  p: Pt;
  tangent: Pt; // 单位切向量（沿迁移方向）
  normal: Pt;  // 左法向
  s: number;   // 起点到该位置的弧长
  index: number;
}

export function sampleAtS(line: Polyline | Pt[], s: number): ArcSample | undefined {
  const pts = line as Pt[];
  if (pts.length < 2) return undefined;
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (s <= acc + segLen + 1e-9) {
      const t = segLen === 0 ? 0 : Math.min(1, Math.max(0, (s - acc) / segLen));
      const tangent = segLen === 0 ? { x: 0, y: 1 } : { x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen };
      const normal = { x: -tangent.y, y: tangent.x };
      return {
        p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        tangent,
        normal,
        s,
        index: i,
      };
    }
    acc += segLen;
  }
  const last = pts[pts.length - 1]!;
  const prev = pts[pts.length - 2]!;
  const dl = Math.hypot(last.x - prev.x, last.y - prev.y) || 1;
  const tangent = { x: (last.x - prev.x) / dl, y: (last.y - prev.y) / dl };
  return { p: last, tangent, normal: { x: -tangent.y, y: tangent.x }, s: acc, index: pts.length - 1 };
}

export function totalArcLength(line: Polyline | Pt[]): number {
  return arcLengthAt(line);
}

// 曲线上距给定点最近的弧长 s（用于把修订像素中心映射为迁移距离）
export function nearestS(line: Polyline | Pt[], p: Pt): { s: number; point: Pt; lateral: number } {
  const pts = line as Pt[];
  let best = { s: 0, point: pts[0]!, lateral: 0, dist: Infinity };
  let acc = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen2 = dx * dx + dy * dy || 1;
    const t = Math.min(1, Math.max(0, ((p.x - a.x) * dx + (p.y - a.y) * dy) / segLen2));
    const q = { x: a.x + dx * t, y: a.y + dy * t };
    const segLen = Math.sqrt(segLen2);
    const dist = Math.hypot(p.x - q.x, p.y - q.y);
    if (dist < best.dist) {
      const tangent = { x: dx / segLen, y: dy / segLen };
      const lateral = (p.x - q.x) * -tangent.y + (p.y - q.y) * tangent.x;
      best = { s: acc + segLen * t, point: q, lateral, dist };
    }
    acc += segLen;
  }
  return best;
}

// 拍摄方向：顺时针角度（0/90/180/270，也接受任意角）。
// oriented_px -> image_px
export function orientedToImage(p: Pt, deg: number, wOriented: number, hOriented: number): Pt {
  const r = ((deg % 360) + 360) % 360;
  if (r === 0) return { ...p };
  const rad = (r * Math.PI) / 180;
  // 先把 oriented 坐标逆时针转回，再按旋转后尺寸平移
  const c = Math.cos(-rad);
  const sn = Math.sin(-rad);
  const x0 = p.x * c - p.y * sn;
  const y0 = p.x * sn + p.y * c;
  const corners = [
    { x: 0, y: 0 },
    { x: wOriented, y: 0 },
    { x: wOriented, y: hOriented },
    { x: 0, y: hOriented },
  ].map((q) => ({ x: q.x * c - q.y * sn, y: q.x * sn + q.y * c }));
  const minX = Math.min(...corners.map((q) => q.x));
  const minY = Math.min(...corners.map((q) => q.y));
  return { x: x0 - minX, y: y0 - minY };
}

// image_px -> oriented_px
export function imageToOriented(p: Pt, deg: number, wImage: number, hImage: number): Pt {
  const r = ((deg % 360) + 360) % 360;
  if (r === 0) return { ...p };
  // 正向旋转后包围盒平移量：对 90/180/270 为已知
  const rad = (r * Math.PI) / 180;
  const c = Math.cos(rad);
  const sn = Math.sin(rad);
  const corners = [
    { x: 0, y: 0 },
    { x: wImage, y: 0 },
    { x: wImage, y: hImage },
    { x: 0, y: hImage },
  ].map((q) => ({ x: q.x * c - q.y * sn, y: q.x * sn + q.y * c }));
  const minX = Math.min(...corners.map((q) => q.x));
  const minY = Math.min(...corners.map((q) => q.y));
  const shifted = { x: p.x + minX, y: p.y + minY };
  return { x: shifted.x * c - shifted.y * sn, y: shifted.x * sn + shifted.y * c };
}

export function orientedDimensions(w: number, h: number, deg: number): { w: number; h: number } {
  const r = ((deg % 360) + 360) % 360;
  return r === 90 || r === 270 ? { w: h, h: w } : { w, h };
}

export function makeSourcedPoint(
  p: Pt,
  frame: SourcedPoint['frame'],
  base: Omit<SourcedPoint['provenance'], never> extends never ? never : {
    origin: SourcedPoint['provenance']['origin'];
    imageMaterialId: string;
    eventId?: string;
    derivationId?: string;
    method?: string;
  },
): SourcedPoint {
  return { x: p.x, y: p.y, frame, provenance: base };
}

// 局部标尺有效区域：沿弧长区间 + 横向像素范围
export function segmentValidRegion(
  sA: number,
  sB: number,
  center: Polyline | Pt[],
  halfWidth: number,
): ValidRegion {
  const a = sampleAtS(center, sA)?.p;
  const b = sampleAtS(center, sB)?.p;
  const xs = [a?.x ?? sA, b?.x ?? sB];
  return {
    frame: 'lane_arc',
    sStart: Math.min(sA, sB),
    sEnd: Math.max(sA, sB),
    xStartPx: Math.min(...xs) - halfWidth,
    xEndPx: Math.max(...xs) + halfWidth,
  };
}

export function inValidRegion(region: ValidRegion, s: number, xImagePx?: number): boolean {
  if (s < region.sStart - 1e-6 || s > region.sEnd + 1e-6) return false;
  if (xImagePx !== undefined && region.xStartPx !== undefined && region.xEndPx !== undefined) {
    if (xImagePx < region.xStartPx - 1e-6 || xImagePx > region.xEndPx + 1e-6) return false;
  }
  return true;
}

export function mapPolylineThrough(
  line: Polyline,
  fn: (p: Pt) => Pt,
): Pt[] {
  return (line as Pt[]).map((p) => fn(p));
}
