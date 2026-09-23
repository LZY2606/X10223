import type { Orientation, PxPoint, PxPolyline } from "./types.js";

/**
 * 原始像素 → 审阅像素（按拍摄方向旋转）。
 * 方向含义：变换后“加样孔在上方、迁移向下”。
 *  - up：原方向即正确
 *  - right：正确视图需顺时针 90°
 *  - down：需 180°
 *  - left：需逆时针 90°
 */
export function orientPoint(p: PxPoint, o: Orientation, w: number, h: number): PxPoint {
  switch (o) {
    case "up":
      return { x: p.x, y: p.y };
    case "right":
      return { x: h - 1 - p.y, y: p.x };
    case "down":
      return { x: w - 1 - p.x, y: h - 1 - p.y };
    case "left":
      return { x: p.y, y: w - 1 - p.x };
  }
}

export function orientedSize(w: number, h: number, o: Orientation): { w: number; h: number } {
  return o === "left" || o === "right" ? { w: h, h: w } : { w, h };
}

export function orientPolyline(pl: PxPolyline, o: Orientation, w: number, h: number): PxPolyline {
  return { coord: "raw-px", pts: pl.pts.map((p) => orientPoint(p, o, w, h)) };
}

export interface Segment {
  ax: number;
  ay: number;
  bx: number;
  by: number;
  s0: number; // 起点累计弧长
  s1: number; // 终点累计弧长
}

export interface PolylineGeom {
  pts: PxPoint[];
  segs: Segment[];
  totalLength: number;
}

export function buildPolyline(pts: PxPoint[]): PolylineGeom {
  const segs: Segment[] = [];
  let s = 0;
  for (let i = 0; i < pts.length - 1; i++) {
    const a = pts[i]!;
    const b = pts[i + 1]!;
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segs.push({ ax: a.x, ay: a.y, bx: b.x, by: b.y, s0: s, s1: s + len });
    s += len;
  }
  return { pts, segs, totalLength: s };
}

/** 弧长 s 处的点坐标（折线内插） */
export function pointAtS(g: PolylineGeom, s: number): PxPoint {
  const clamped = Math.max(0, Math.min(g.totalLength, s));
  for (const seg of g.segs) {
    if (clamped >= seg.s0 - 1e-9 && clamped <= seg.s1 + 1e-9) {
      const t = seg.s1 === seg.s0 ? 0 : (clamped - seg.s0) / (seg.s1 - seg.s0);
      return { x: seg.ax + (seg.bx - seg.ax) * t, y: seg.ay + (seg.by - seg.ay) * t };
    }
  }
  return g.pts[g.pts.length - 1]!;
}

export interface Projection {
  s: number;
  /** 到折线的最短距离（带符号：左负右正，按折线切向右手侧为正） */
  d: number;
  point: PxPoint;
}

/** 将点投影到折线，返回弧长与法向距离 */
export function projectToPolyline(g: PolylineGeom, p: PxPoint): Projection {
  let best: { s: number; d: number; point: PxPoint } | null = null;
  let bestDist = Infinity;
  for (const seg of g.segs) {
    const vx = seg.bx - seg.ax;
    const vy = seg.by - seg.ay;
    const wx = p.x - seg.ax;
    const wy = p.y - seg.ay;
    const l2 = vx * vx + vy * vy;
    let t = l2 === 0 ? 0 : (wx * vx + wy * vy) / l2;
    t = Math.max(0, Math.min(1, t));
    const qx = seg.ax + vx * t;
    const qy = seg.ay + vy * t;
    const dist = Math.hypot(p.x - qx, p.y - qy);
    if (dist < bestDist) {
      // 叉积决定左右
      const cross = vx * (p.y - seg.ay) - vy * (p.x - seg.ax);
      bestDist = dist;
      best = {
        s: seg.s0 + t * (seg.s1 - seg.s0),
        d: Math.sign(cross || dist) * dist,
        point: { x: qx, y: qy },
      };
    }
  }
  return best!;
}

/** 两条边界的中线（逐点平均） */
export function centerline(left: PxPolyline, right: PxPolyline): PxPolyline {
  const n = Math.min(left.pts.length, right.pts.length);
  const pts: PxPoint[] = [];
  for (let i = 0; i < n; i++) {
    pts.push({ x: (left.pts[i]!.x + right.pts[i]!.x) / 2, y: (left.pts[i]!.y + right.pts[i]!.y) / 2 });
  }
  return { coord: "raw-px", pts };
}

/** 点是否在两条边界折线之间（按弧长法向距离判定） */
export function insideLane(
  leftG: PolylineGeom,
  rightG: PolylineGeom,
  centerG: PolylineGeom,
  p: PxPoint,
  tolerance = 0,
): boolean {
  const dl = Math.abs(projectToPolyline(leftG, p).d);
  const dr = Math.abs(projectToPolyline(rightG, p).d);
  const pr = projectToPolyline(centerG, p);
  const half = (dl + dr) / 2 + tolerance;
  return Math.abs(pr.d) <= half && pr.s >= 0 && pr.s <= centerG.totalLength;
}
