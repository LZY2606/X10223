export interface Point {
  x: number;
  y: number;
}

export function distance(a: Point, b: Point): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export function arcLength(points: Point[]): number {
  let total = 0;
  for (let index = 1; index < points.length; index += 1) {
    total += distance(points[index - 1]!, points[index]!);
  }
  return total;
}

export function pointAtArcLength(points: Point[], target: number): { point: Point; segmentIndex: number; tangent: Point } {
  if (points.length < 2) throw new Error('polyline requires two points');
  if (target < 0 || target > arcLength(points) + 1e-9) throw new RangeError('arc length outside polyline');
  let traversed = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const segment = distance(start, end);
    if (traversed + segment + 1e-9 >= target) {
      const ratio = segment === 0 ? 0 : (target - traversed) / segment;
      const tangent = segment === 0 ? { x: 0, y: 1 } : { x: (end.x - start.x) / segment, y: (end.y - start.y) / segment };
      return {
        point: { x: start.x + (end.x - start.x) * ratio, y: start.y + (end.y - start.y) * ratio },
        segmentIndex: index - 1,
        tangent
      };
    }
    traversed += segment;
  }
  const last = points.at(-1)!;
  return { point: last, segmentIndex: points.length - 2, tangent: { x: 0, y: 1 } };
}

export function projectToPolyline(points: Point[], query: Point): { migration: number; lateral: number; nearest: Point } {
  let best: { migration: number; lateral: number; nearest: Point } | undefined;
  let traversed = 0;
  for (let index = 1; index < points.length; index += 1) {
    const start = points[index - 1]!;
    const end = points[index]!;
    const dx = end.x - start.x;
    const dy = end.y - start.y;
    const length2 = dx * dx + dy * dy;
    const ratio = length2 === 0 ? 0 : Math.min(1, Math.max(0, ((query.x - start.x) * dx + (query.y - start.y) * dy) / length2));
    const nearest = { x: start.x + dx * ratio, y: start.y + dy * ratio };
    const tangent = length2 === 0 ? { x: 0, y: 1 } : { x: dx / Math.sqrt(length2), y: dy / Math.sqrt(length2) };
    const migration = traversed + Math.sqrt(length2) * ratio;
    const offsetX = query.x - nearest.x;
    const offsetY = query.y - nearest.y;
    const lateral = tangent.x === 0 && tangent.y === 1 ? offsetX : offsetX * -tangent.y + offsetY * tangent.x;
    const candidate = { migration, lateral, nearest };
    if (!best || Math.abs(candidate.lateral) < Math.abs(best.lateral)) best = candidate;
    traversed += Math.sqrt(length2);
  }
  if (!best) throw new Error('empty polyline');
  return best;
}

export function rotatePointClockwise(point: Point, angleDeg: number, width: number, height: number): Point {
  const angle = ((angleDeg % 360) + 360) % 360;
  if (angle === 0) return { ...point };
  if (Math.abs(angle - 90) < 1e-9) return { x: height - point.y, y: point.x };
  if (Math.abs(angle - 180) < 1e-9) return { x: width - point.x, y: height - point.y };
  if (Math.abs(angle - 270) < 1e-9) return { x: point.y, y: width - point.x };
  const radians = angle * Math.PI / 180;
  const x = point.x * Math.cos(radians) + point.y * Math.sin(radians);
  const y = -point.x * Math.sin(radians) + point.y * Math.cos(radians);
  return { x, y };
}

export function makeStraightPolyline(x: number, top: number, bottom: number, step = 20): Point[] {
  const points: Point[] = [];
  for (let y = top; y <= bottom; y += step) points.push({ x, y });
  if (points.at(-1)?.y !== bottom) points.push({ x, y: bottom });
  return points;
}

export function makeSmilePolyline(x: number, top: number, bottom: number, bow: number, step = 20): Point[] {
  const points: Point[] = [];
  for (let y = top; y <= bottom; y += step) {
    const t = (y - top) / (bottom - top);
    points.push({ x: x + bow * Math.sin(Math.PI * t), y });
  }
  if (points.at(-1)?.y !== bottom) points.push({ x, y: bottom });
  return points;
}
