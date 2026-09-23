// Lane geometry. Bands are projected onto a curved lane centerline and their
// migration distance is ARC LENGTH from the lane's well end. This is what makes
// a "smile": two bands at the same image y can sit on lanes with different
// curvature, so they get different migration (and molecular weight).
import { LaneBoundaryMaterial, BandCenterMaterial, incomplete } from './types.js';

export interface Pt { x: number; y: number }

export interface Projection {
  arcLength: number;          // along centerline from first polyline vertex
  t: number;                  // 0..1 parameter
  nearest: Pt;                // projected point on centerline
  distanceToCenterline: number;
  inside: boolean;            // within lane half width
}

function dist(a: Pt, b: Pt): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function projectToPolyline(poly: Pt[], p: Pt): Projection {
  if (poly.length < 2) throw incomplete('lane.centerlinePx', 'centerline needs >= 2 points');
  let best: Projection | null = null;
  let cum = 0;
  for (let i = 1; i < poly.length; i++) {
    const a = poly[i - 1]!, b = poly[i]!;
    const segLen = dist(a, b);
    const vx = b.x - a.x, vy = b.y - a.y;
    let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / (segLen * segLen);
    t = Math.max(0, Math.min(1, t));
    const q = { x: a.x + t * vx, y: a.y + t * vy };
    const d = dist(p, q);
    if (!best || d < best.distanceToCenterline) {
      best = { arcLength: cum + t * segLen, t: (i - 1 + t) / (poly.length - 1), nearest: q, distanceToCenterline: d, inside: false };
    }
    cum += segLen;
  }
  return best!;
}

export interface LaneGeometry {
  lane: LaneBoundaryMaterial;
  totalLength: number;
  bandArc: Map<string, { band: BandCenterMaterial; arc: number; inside: boolean }>;
}

export function buildLaneGeometry(lane: LaneBoundaryMaterial, bands: BandCenterMaterial[]): LaneGeometry {
  const total = polylineLength(lane.centerlinePx);
  const bandArc = new Map<string, { band: BandCenterMaterial; arc: number; inside: boolean }>();
  for (const b of bands) {
    const pr = projectToPolyline(lane.centerlinePx, b.centerPx);
    const inside = pr.distanceToCenterline <= lane.halfWidthPx;
    bandArc.set(b.id, { band: b, arc: pr.arcLength, inside });
  }
  return { lane, totalLength: total, bandArc };
}

export function polylineLength(poly: Pt[]): number {
  let len = 0;
  for (let i = 1; i < poly.length; i++) len += dist(poly[i - 1]!, poly[i]!);
  return len;
}
