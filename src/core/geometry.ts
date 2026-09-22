import type { PixelPoint } from '../shared/types';

export interface Vec2 {
  x: number;
  y: number;
}

/** Catmull-Rom 采样 */
export function catmullRom(points: Vec2[], samplesPerSegment = 24): Vec2[] {
  if (points.length < 2) return points.slice();
  const pts = [points[0], ...points, points[points.length - 1]];
  const out: Vec2[] = [];
  for (let i = 0; i < pts.length - 3; i++) {
    const p0 = pts[i];
    const p1 = pts[i + 1];
    const p2 = pts[i + 2];
    const p3 = pts[i + 3];
    for (let j = 0; j < samplesPerSegment; j++) {
      const t = j / samplesPerSegment;
      const t2 = t * t;
      const t3 = t2 * t;
      const x =
        0.5 *
        (2 * p1.x +
          (-p0.x + p2.x) * t +
          (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
          (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3);
      const y =
        0.5 *
        (2 * p1.y +
          (-p0.y + p2.y) * t +
          (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
          (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3);
      out.push({ x, y });
    }
  }
  out.push(points[points.length - 1]);
  return out;
}

export function polylineLength(poly: Vec2[]): number {
  let len = 0;
  for (let i = 1; i < poly.length; i++) {
    len += Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y);
  }
  return len;
}

/** 沿折线返回累积弧长 */
export function arcLengthTable(poly: Vec2[]): number[] {
  const table = [0];
  for (let i = 1; i < poly.length; i++) {
    table.push(table[i - 1] + Math.hypot(poly[i].x - poly[i - 1].x, poly[i].y - poly[i - 1].y));
  }
  return table;
}

/** 在折线上按弧长 t 插值取点与法线方向 */
export function pointAtArcLength(
  poly: Vec2[],
  table: number[],
  t: number
): { point: Vec2; tangent: Vec2 } {
  const total = table[table.length - 1];
  const tt = Math.max(0, Math.min(total, t));
  let i = 1;
  while (i < table.length - 1 && table[i] < tt) i++;
  const segLen = table[i] - table[i - 1] || 1;
  const f = (tt - table[i - 1]) / segLen;
  const a = poly[i - 1];
  const b = poly[i];
  const tx = (b.x - a.x) / segLen;
  const ty = (b.y - a.y) / segLen;
  return { point: { x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f }, tangent: { x: tx, y: ty } };
}

export function stripPoints(poly: Vec2[], table: number[], t: number, halfWidth: number): Vec2[] {
  const { point, tangent } = pointAtArcLength(poly, table, t);
  const nx = -tangent.y;
  const ny = tangent.x;
  return [
    { x: point.x + nx * halfWidth, y: point.y + ny * halfWidth },
    { x: point.x - nx * halfWidth, y: point.y - ny * halfWidth },
  ];
}

/** 顺时针旋转 90/180/270 度，返回新光栅（像素级精确：仅像素搬运） */
export function rotateCW(
  img: { width: number; height: number; data: Uint8Array; channels: 1 | 3 },
  deg: 90 | 180 | 270
): { width: number; height: number; data: Uint8Array } {
  const { width: w, height: h, data, channels: c } = img;
  if (deg === 180) {
    const out = new Uint8Array(data.length);
    for (let y = 0; y < h; y++) {
      for (let x = 0; x < w; x++) {
        for (let k = 0; k < c; k++) {
          out[(y * w + x) * c + k] = data[((h - 1 - y) * w + (w - 1 - x)) * c + k];
        }
      }
    }
    return { width: w, height: h, data: out };
  }
  const out = new Uint8Array(w * h * c);
  const cw = deg === 90;
  const nw = cw ? h : h;
  const nh = cw ? w : w;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const nx = cw ? h - 1 - y : y;
      const ny = cw ? x : w - 1 - x;
      for (let k = 0; k < c; k++) {
        out[(ny * nw + nx) * c + k] = data[(y * w + x) * c + k];
      }
    }
  }
  return { width: nw, height: nh, data: out };
}

export function pointToBasis(p: PixelPoint, targetOrientationDeg: 0 | 90 | 180 | 270, w: number, h: number): Vec2 {
  let { x, y } = p;
  let cur = p.basis.orientationDeg;
  let cw = w;
  let ch = h;
  while (cur !== targetOrientationDeg) {
    const nx = ch - 1 - y;
    const ny = x;
    x = nx;
    y = ny;
    const tmp = cw;
    cw = ch;
    ch = tmp;
    cur = ((cur + 90) % 360) as 0 | 90 | 180 | 270;
  }
  return { x, y };
}
