import { IncompleteInputDiagnostics } from './errors.js';
import type {
  LaneCurve,
  LaneMaterial,
  OrientationMaterial,
  OrientedPoint,
  PixelPoint,
  Quantity
} from './types.js';

export interface ProjectedPoint {
  point: OrientedPoint;
  arcLength: number;
  lateralResidualPx: number;
  segmentIndex: number;
}

export function rotateRawPoint(point: PixelPoint, orientation: OrientationMaterial, rawWidth: number, rawHeight: number): OrientedPoint {
  let x = point.x;
  let y = point.y;
  switch (orientation.rotationDeg) {
    case 0:
      break;
    case 90:
      x = rawHeight - point.y - 1;
      y = point.x;
      break;
    case 180:
      x = rawWidth - point.x - 1;
      y = rawHeight - point.y - 1;
      break;
    case 270:
      x = point.y;
      y = rawWidth - point.x - 1;
      break;
  }
  if (orientation.flipHorizontal) x = orientedWidth(orientation, rawWidth, rawHeight) - x - 1;
  if (orientation.flipVertical) y = orientedHeight(orientation, rawWidth, rawHeight) - y - 1;
  return { x, y, coordinateSystem: 'oriented-image', unit: 'px' };
}

export function orientedWidth(orientation: OrientationMaterial, rawWidth: number, rawHeight: number): number {
  return orientation.rotationDeg === 90 || orientation.rotationDeg === 270 ? rawHeight : rawWidth;
}

export function orientedHeight(orientation: OrientationMaterial, rawWidth: number, rawHeight: number): number {
  return orientation.rotationDeg === 90 || orientation.rotationDeg === 270 ? rawWidth : rawHeight;
}

export function laneCenterline(lane: LaneMaterial): PixelPoint[] {
  const count = Math.min(lane.left.length, lane.right.length);
  const points: PixelPoint[] = [];
  for (let index = 0; index < count; index += 1) {
    points.push({
      x: (lane.left[index].x + lane.right[index].x) / 2,
      y: (lane.left[index].y + lane.right[index].y) / 2,
      coordinateSystem: 'raw-image',
      unit: 'px'
    });
  }
  return points;
}

export function orientedLaneCurve(
  lane: LaneMaterial,
  orientation: OrientationMaterial,
  rawWidth: number,
  rawHeight: number
): LaneCurve {
  const points = laneCenterline(lane).map((point) => rotateRawPoint(point, orientation, rawWidth, rawHeight));
  return {
    laneSubjectId: lane.subjectId,
    points,
    arcLength: { value: cumulativeArc(points).at(-1) ?? 0, unit: 'px' }
  };
}

export function cumulativeArc(points: OrientedPoint[]): number[] {
  const result: number[] = [];
  let total = 0;
  points.forEach((point, index) => {
    if (index > 0) {
      total += Math.hypot(point.x - points[index - 1].x, point.y - points[index - 1].y);
    }
    result.push(total);
  });
  return result;
}

export function projectToCurve(point: OrientedPoint, curve: LaneCurve): ProjectedPoint {
  if (curve.points.length < 2) {
    throw new IncompleteInputDiagnostics([
      {
        code: 'INCOMPLETE_INPUT',
        message: 'Lane curve requires at least two control points',
        path: `laneCurves.${curve.laneSubjectId}`
      }
    ]);
  }
  const arcs = cumulativeArc(curve.points);
  let best: { arcLength: number; residual: number; t: number; index: number; distance: number } | undefined;
  for (let index = 0; index < curve.points.length - 1; index += 1) {
    const a = curve.points[index];
    const b = curve.points[index + 1];
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const denominator = dx * dx + dy * dy;
    const t = denominator === 0 ? 0 : clamp(((point.x - a.x) * dx + (point.y - a.y) * dy) / denominator, 0, 1);
    const closestX = a.x + dx * t;
    const closestY = a.y + dy * t;
    const distance = Math.hypot(point.x - closestX, point.y - closestY);
    if (!best || distance < best.distance) {
      best = {
        arcLength: arcs[index] + t * (arcs[index + 1] - arcs[index]),
        residual: signedResidual(point, a, b),
        t,
        index,
        distance
      };
    }
  }
  if (!best) throw new Error('Curve projection failed');
  return {
    point,
    arcLength: best.arcLength,
    lateralResidualPx: best.residual,
    segmentIndex: best.index
  };
}

export function pxQuantity(value: number, coordinateSystem: Quantity['unit'] = 'px'): Quantity {
  return { value, unit: coordinateSystem };
}

function signedResidual(point: OrientedPoint, a: OrientedPoint, b: OrientedPoint): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy);
  if (length === 0) return Math.hypot(point.x - a.x, point.y - a.y);
  return (dx * (point.y - a.y) - dy * (point.x - a.x)) / length;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
