export interface Pt {
  x: number;
  y: number;
}

export function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** 折线累计弧长（像素），返回与点等长的数组。 */
export function cumulativeLength(polyline: Pt[]): number[] {
  const out = [0];
  for (let i = 1; i < polyline.length; i++) {
    out.push(out[i - 1] + dist(polyline[i - 1], polyline[i]));
  }
  return out;
}

/** 在折线上按弧长 s 插值，返回像素点；越界返回 null（由调用方产生越界诊断）。 */
export function pointAtLength(polyline: Pt[], s: number): Pt | null {
  if (polyline.length === 0) return null;
  const cum = cumulativeLength(polyline);
  if (s < 0 || s > cum[cum.length - 1]) return null;
  for (let i = 1; i < cum.length; i++) {
    if (s <= cum[i]) {
      const segLen = cum[i] - cum[i - 1];
      const t = segLen === 0 ? 0 : (s - cum[i - 1]) / segLen;
      return {
        x: polyline[i - 1].x + (polyline[i].x - polyline[i - 1].x) * t,
        y: polyline[i - 1].y + (polyline[i].y - polyline[i - 1].y) * t
      };
    }
  }
  return polyline[polyline.length - 1];
}

/** 点在折线上的投影弧长（像素）。微笑弯曲时必须用它，而不是图像 y。 */
export function projectOntoPolyline(p: Pt, polyline: Pt[]): { s: number; lateral: number } {
  let best = { s: 0, d2: Infinity, px: polyline[0] };
  let cumPrev = 0;
  for (let i = 1; i < polyline.length; i++) {
    const a = polyline[i - 1];
    const b = polyline[i];
    const segLen = dist(a, b);
    const t =
      segLen === 0
        ? 0
        : Math.min(1, Math.max(0, ((p.x - a.x) * (b.x - a.x) + (p.y - a.y) * (b.y - a.y)) / (segLen * segLen)));
    const qx = a.x + (b.x - a.x) * t;
    const qy = a.y + (b.y - a.y) * t;
    const d2 = (p.x - qx) ** 2 + (p.y - qy) ** 2;
    if (d2 < best.d2) {
      const segBefore = segLen * t;
      best = { s: cumPrev + segBefore, d2, px: { x: qx, y: qy } };
    }
    cumPrev += segLen;
  }
  return { s: best.s, lateral: Math.sqrt(best.d2) };
}

/** 逆时针旋转（degree），用于绕显示帧中心把像素坐标转回原始帧。 */
export function rotatePoint(p: Pt, angleDeg: number, cx: number, cy: number): Pt {
  const a = (-angleDeg * Math.PI) / 180;
  const x = p.x - cx;
  const y = p.y - cy;
  return {
    x: cx + x * Math.cos(a) - y * Math.sin(a),
    y: cy + x * Math.sin(a) + y * Math.cos(a)
  };
}
