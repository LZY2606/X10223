import type { PixelPoint, Rotation } from '../shared/types.js';

export interface PixelImage {
  width: number;
  height: number;
  // 8-bit 灰度，长度 width*height，行优先
  gray: Uint8Array;
}

// 对“原图上的点”施加拍摄方向确认后的旋转：orientation 事件不改材料，只在派生层执行
export function rotatePoint(p: PixelPoint, rot: Rotation, w: number, h: number): PixelPoint {
  switch (rot) {
    case 0: return { ...p };
    case 90: return { x: h - 1 - p.y, y: p.x };
    case 180: return { x: w - 1 - p.x, y: h - 1 - p.y };
    case 270: return { x: p.y, y: w - 1 - p.x };
  }
}

export function rotateLanePoints(points: PixelPoint[], rot: Rotation, w: number, h: number): PixelPoint[] {
  return points.map((p) => rotatePoint(p, rot, w, h));
}

export function rotateImage(img: PixelImage, rot: Rotation): PixelImage {
  if (rot === 0) return img;
  const swp = rot === 90 || rot === 270;
  const w2 = swp ? img.height : img.width;
  const h2 = swp ? img.width : img.height;
  const out = new Uint8Array(w2 * h2);
  for (let y = 0; y < img.height; y++) {
    for (let x = 0; x < img.width; x++) {
      const q = rotatePoint({ x, y }, rot, img.width, img.height);
      out[q.y * w2 + q.x] = img.gray[y * img.width + x];
    }
  }
  return { width: w2, height: h2, gray: out };
}

// 折线上的弧长几何：s=0 在井一侧（points[0]），向迁移方向递增
export interface ArcGeometry {
  cum: number[];      // 每个折线点累计弧长 px
  total: number;
}

export function arcGeometry(points: PixelPoint[]): ArcGeometry {
  const cum = [0];
  for (let i = 1; i < points.length; i++) {
    const dx = points[i].x - points[i - 1].x;
    const dy = points[i].y - points[i - 1].y;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return { cum, total: cum[cum.length - 1] };
}

function pointAtS(points: PixelPoint[], cum: number[], s: number): PixelPoint {
  if (s <= 0) return { ...points[0] };
  for (let i = 1; i < points.length; i++) {
    if (s <= cum[i]) {
      const segLen = cum[i] - cum[i - 1] || 1;
      const t = (s - cum[i - 1]) / segLen;
      return {
        x: points[i - 1].x + (points[i].x - points[i - 1].x) * t,
        y: points[i - 1].y + (points[i].y - points[i - 1].y) * t,
      };
    }
  }
  return { ...points[points.length - 1] };
}

export function projectPointToLane(p: PixelPoint, points: PixelPoint[], geom?: ArcGeometry): { s: number; lateral: number } {
  const g = geom ?? arcGeometry(points);
  let best = { s: 0, d: Infinity };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1], b = points[i];
    const vx = b.x - a.x, vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((p.x - a.x) * vx + (p.y - a.y) * vy) / len2));
    const qx = a.x + vx * t, qy = a.y + vy * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < best.d) {
      const segLen = g.cum[i] - g.cum[i - 1] || 1;
      best = { s: g.cum[i - 1] + segLen * t, d };
    }
  }
  // 带符号横向距离：点在中心线“右侧”为正
  const nearest = pointAtS(points, g.cum, best.s);
  const lateral = Math.hypot(p.x - nearest.x, p.y - nearest.y) * (p.x - nearest.x >= 0 ? 1 : -1);
  return { s: best.s, lateral };
}

// 沿弧长在垂直方向取截面平均
export function crossSectionMean(
  img: PixelImage, points: PixelPoint[], s: number, halfWidth: number,
): { mean: number; saturatedCount: number; samples: number } {
  const g = arcGeometry(points);
  const center = pointAtS(points, g.cum, s);
  // 找 s 处切线方向
  let i = 1;
  while (i < points.length && g.cum[i] < s) i++;
  const a = points[Math.max(0, i - 1)], b = points[Math.min(points.length - 1, i)];
  let tx = b.x - a.x, ty = b.y - a.y;
  const tl = Math.hypot(tx, ty) || 1;
  tx /= tl; ty /= tl;
  const nx = -ty, ny = tx;
  let sum = 0, n = 0, sat = 0;
  for (let off = -halfWidth; off <= halfWidth; off++) {
    const x = Math.round(center.x + nx * off);
    const y = Math.round(center.y + ny * off);
    if (x < 0 || y < 0 || x >= img.width || y >= img.height) continue;
    sum += img.gray[y * img.width + x];
    if (img.gray[y * img.width + x] >= 255) sat++;
    n++;
  }
  return { mean: n ? sum / n : 0, saturatedCount: sat, samples: n };
}
