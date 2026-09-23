export interface Pt {
  x: number;
  y: number;
}

/** Rotate a point from raw stored orientation into normalized (wells-up) frame. */
export function rotatePoint(p: Pt, deg: 0 | 90 | 180 | 270, w: number, h: number): Pt {
  switch (deg) {
    case 0: return { x: p.x, y: p.y };
    case 90: return { x: p.y, y: w - 1 - p.x };
    case 180: return { x: w - 1 - p.x, y: h - 1 - p.y };
    case 270: return { x: h - 1 - p.y, y: p.x };
  }
}

/** Inverse of rotatePoint: map a normalized coordinate back to its raw pixel provenance. */
export function unrotatePoint(p: Pt, deg: 0 | 90 | 180 | 270, w: number, h: number): Pt {
  switch (deg) {
    case 0: return { x: p.x, y: p.y };
    case 90: return { x: w - 1 - p.y, y: p.x };
    case 180: return { x: w - 1 - p.x, y: h - 1 - p.y };
    case 270: return { x: p.y, y: h - 1 - p.x };
  }
}

export function rotatedSize(deg: 0 | 90 | 180 | 270, w: number, h: number): { w: number; h: number } {
  return deg === 90 || deg === 270 ? { w: h, h: w } : { w, h };
}

/** Lane centerline model in normalized frame: x(y) = c0 + c1*y + c2*y^2 (smile curvature). */
export interface LaneCurve {
  c0: number;
  c1: number;
  c2: number;
}

export function fitLaneCurve(points: Pt[]): LaneCurve {
  const n = points.length;
  if (n < 3) {
    const cx = points.reduce((s, p) => s + p.x, 0) / Math.max(1, n);
    return { c0: cx, c1: 0, c2: 0 };
  }
  // least squares for x = c0 + c1*y + c2*y^2
  let s0 = n, s1 = 0, s2 = 0, s3 = 0, s4 = 0, t0 = 0, t1 = 0, t2 = 0;
  for (const p of points) {
    const y = p.y, y2 = y * y;
    s1 += y; s2 += y2; s3 += y2 * y; s4 += y2 * y2;
    t0 += p.x; t1 += p.x * y; t2 += p.x * y2;
  }
  const A = [[s0, s1, s2], [s1, s2, s3], [s2, s3, s4]];
  const b = [t0, t1, t2];
  // gaussian elimination
  for (let col = 0; col < 3; col++) {
    let piv = col;
    for (let r = col + 1; r < 3; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    [A[col], A[piv]] = [A[piv], A[col]];
    [b[col], b[piv]] = [b[piv], b[col]];
    const d = A[col][col] || 1e-12;
    for (let r = 0; r < 3; r++) {
      if (r === col) continue;
      const f = A[r][col] / d;
      for (let c = 0; c < 3; c++) A[r][c] -= f * A[col][c];
      b[r] -= f * b[col];
    }
  }
  return { c0: b[0] / (A[0][0] || 1e-12), c1: b[1] / (A[1][1] || 1e-12), c2: b[2] / (A[2][2] || 1e-12) };
}

/**
 * Smile offset: how far the dye front at height y is displaced vertically
 * for a lane whose centerline curves horizontally. A horizontal line (same y)
 * therefore does NOT correspond to the same molecular weight across lanes.
 */
export function smileOffset(curve: LaneCurve, y: number): number {
  return curve.c2 * y * y + curve.c1 * y;
}
