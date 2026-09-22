/** 泳道几何：以泳道中心折线的弧长 s（px）作为迁移距离坐标。 */

export interface Pt {
  x: number;
  y: number;
}

export function cumulativeLengths(line: Pt[]): number[] {
  const cum: number[] = [0];
  for (let i = 1; i < line.length; i++) {
    const dx = line[i].x - line[i - 1].x;
    const dy = line[i].y - line[i - 1].y;
    cum.push(cum[i - 1] + Math.hypot(dx, dy));
  }
  return cum;
}

export function polylineLength(line: Pt[]): number {
  const cum = cumulativeLengths(line);
  return cum[cum.length - 1] ?? 0;
}

/** 点 p 投影到折线上，返回弧长 s 与垂直距离。 */
export function projectOntoPolyline(line: Pt[], p: Pt): { s: number; dist: number } {
  const cum = cumulativeLengths(line);
  let bestS = 0;
  let bestDist = Number.POSITIVE_INFINITY;
  for (let i = 0; i < line.length - 1; i++) {
    const a = line[i];
    const b = line[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    if (len2 === 0) continue;
    let t = ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2;
    t = Math.max(0, Math.min(1, t));
    const qx = a.x + t * abx;
    const qy = a.y + t * aby;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bestDist) {
      bestDist = d;
      bestS = cum[i] + t * Math.sqrt(len2);
    }
  }
  return { s: bestS, dist: bestDist };
}

/** 弧长 s 处的折线点（用于把有效区域换算回像素 y）。 */
export function pointAtS(line: Pt[], s: number): Pt {
  const cum = cumulativeLengths(line);
  const total = cum[cum.length - 1] ?? 0;
  const target = Math.max(0, Math.min(total, s));
  for (let i = 0; i < cum.length - 1; i++) {
    if (target <= cum[i + 1]) {
      const seg = cum[i + 1] - cum[i];
      const t = seg === 0 ? 0 : (target - cum[i]) / seg;
      return {
        x: line[i].x + t * (line[i + 1].x - line[i].x),
        y: line[i].y + t * (line[i + 1].y - line[i].y)
      };
    }
  }
  return line[line.length - 1];
}

/** 90 度旋转坐标变换（顺时针），用于旋转图像后的坐标重定基。 */
export function rotatePoint90(p: Pt, width: number): Pt {
  return { x: width - 1 - p.y, y: p.x };
}
