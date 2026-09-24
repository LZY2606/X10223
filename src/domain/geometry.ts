import type { PixelPoint, Point, Polyline } from "../shared/types.js";

export function polylineLength(line: Polyline): number {
  let total = 0;
  for (let i = 1; i < line.points.length; i++) {
    const a = line.points[i - 1];
    const b = line.points[i];
    total += Math.hypot(b.x - a.x, b.y - a.y);
  }
  return total;
}

export function pointAtArcFraction(line: Polyline, f: number): { p: Point; tangent: Point; arc: number } {
  const total = polylineLength(line);
  return pointAtArc(line, f * total);
}

export function pointAtArc(line: Polyline, target: number): { p: Point; tangent: Point; arc: number } {
  const pts = line.points;
  if (pts.length === 1) return { p: { x: pts[0].x, y: pts[0].y }, tangent: { x: 0, y: 1 }, arc: 0 };
  let acc = 0;
  for (let i = 1; i < pts.length; i++) {
    const a = pts[i - 1];
    const b = pts[i];
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + segLen >= target || i === pts.length - 1) {
      const t = segLen === 0 ? 0 : Math.min(1, Math.max(0, (target - acc) / segLen));
      return {
        p: { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t },
        tangent: segLen === 0 ? { x: 0, y: 1 } : { x: (b.x - a.x) / segLen, y: (b.y - a.y) / segLen },
        arc: acc + segLen * t
      };
    }
    acc += segLen;
  }
  const last = pts[pts.length - 1];
  return { p: { x: last.x, y: last.y }, tangent: { x: 0, y: 1 }, arc: total };
}

export function projectPointToPolyline(p: Point, line: Polyline): { arc: number; pLine: Point; distance: number; tangent: Point } {
  let best = { arc: 0, pLine: { x: line.points[0].x, y: line.points[0].y }, distance: Infinity, tangent: { x: 0, y: 1 } };
  let acc = 0;
  for (let i = 1; i < line.points.length; i++) {
    const a = line.points[i - 1];
    const b = line.points[i];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const segLen = Math.hypot(dx, dy);
    const t = segLen === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / (segLen * segLen)));
    const qx = a.x + dx * t;
    const qy = a.y + dy * t;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < best.distance) {
      best = {
        arc: acc + segLen * t,
        pLine: { x: qx, y: qy },
        distance: d,
        tangent: segLen === 0 ? { x: 0, y: 1 } : { x: dx / segLen, y: dy / segLen }
      };
    }
    acc += segLen;
  }
  return best;
}

export function rotatePoint(p: PixelPoint, deg: number, cx: number, cy: number, newW: number, newH: number): PixelPoint {
  const rad = (-deg * Math.PI) / 180;
  const cos = Math.cos(rad);
  const sin = Math.sin(rad);
  const dx = p.x - cx;
  const dy = p.y - cy;
  const rx = dx * cos - dy * sin + newW / 2;
  const ry = dx * sin + dy * cos + newH / 2;
  return { ...p, x: rx, y: ry, frame: "oriented-image-px", imageId: p.imageId };
}

export function rotatedDimensions(w: number, h: number, deg: number): { w: number; h: number } {
  const norm = ((deg % 360) + 360) % 360;
  if (norm === 90 || norm === 270) return { w: h, h: w };
  return { w, h };
}

export function distanceToSegment(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.y - a.y) * dy) / len2));
  return Math.hypot(p.x - (a.x + dx * t), p.y - (a.y + dy * t));
}

export function minDistanceToPolyline(p: Point, line: Polyline): number {
  let best = Infinity;
  for (let i = 1; i < line.points.length; i++) {
    best = Math.min(best, distanceToSegment(p, line.points[i - 1], line.points[i]));
  }
  return best;
}
