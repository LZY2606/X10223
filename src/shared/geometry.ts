import type { Diagnostic, Frame, Point, Q, Unit } from './types.js';

export function q(value: number, unit: Unit, basis?: string, raw?: string): Q {
  const out: Q = { value, unit };
  if (basis) out.basis = basis;
  if (raw !== undefined) out.raw = raw;
  return out;
}

/** 导入层保留原始表示；无法转换的值留在原位并附诊断（绝不为画图丢掉）。 */
export function parseQ(
  raw: string,
  expected: Unit,
  position: Diagnostic['position'],
): { value?: Q; diagnostic?: Diagnostic } {
  const text = String(raw).trim();
  const match = /^(-?\d+(?:\.\d+)?)(?:\s*([a-zA-Z%.a-z]+))?$/.exec(text);
  if (!match) {
    return {
      diagnostic: {
        code: 'Q_UNCONVERTIBLE',
        severity: 'error',
        failureClass: 'SEMANTIC_NO_SOLUTION',
        message: `无法将“${text}”转换为 ${expected}，保留原始表示于原位置`,
        position,
      },
    };
  }
  const number = Number(match[1]);
  const rawUnit = (match[2] ?? expected) as Unit;
  if (rawUnit !== expected) {
    return {
      diagnostic: {
        code: 'Q_UNIT_MISMATCH',
        severity: 'error',
        failureClass: 'SEMANTIC_NO_SOLUTION',
        message: `单位 ${rawUnit} 与期望 ${expected} 不一致`,
        position,
      },
    };
  }
  return { value: q(number, expected, undefined, text) };
}

export function imageFrame(imageId: string, w: number, h: number): Frame {
  return {
    id: `frame-${imageId}`,
    type: 'image-px',
    origin: { x: 0, y: 0 },
    axes: { x: 'x px (left→right)', y: 'y px (top→bottom)' },
    basis: `image=${imageId} 左上角原点；${w}×${h} px；拍摄像素坐标`,
  };
}

export function arcFrame(laneId: string, imageId: string): Frame {
  return {
    id: `frame-arc-${laneId}`,
    type: 'arc-s',
    origin: { x: 0, y: 0 },
    axes: { x: 's px', y: '沿泳道中心线迁移弧长' },
    basis: `lane=${laneId} image=${imageId}；s 自顶端中心线起点累计弧长`,
  };
}

/** 由左右边界折线求中心线。弯曲泳道时中心线也是折线，弧长 != y。 */
export function centerline(left: Point[], right: Point[]): Point[] {
  const n = Math.min(left.length, right.length);
  const out: Point[] = [];
  for (let i = 0; i < n; i++) {
    out.push({ x: (left[i].x + right[i].x) / 2, y: (left[i].y + right[i].y) / 2 });
  }
  return out;
}

export function cumulativeLength(points: Point[]): { seg: number[]; total: number } {
  const seg = [0];
  let total = 0;
  for (let i = 1; i < points.length; i++) {
    total += Math.hypot(points[i].x - points[i - 1].x, points[i].y - points[i - 1].y);
    seg.push(total);
  }
  return { seg, total };
}

/** 沿折线取弧长 s 处的点与切线；这是“微笑弯曲时同高不同分子量”的关键。 */
export function pointAtArc(points: Point[], s: number): { point: Point; tangent: Point } {
  const { seg } = cumulativeLength(points);
  if (s <= 0) {
    const t = tangent(points, 0);
    return { point: { ...points[0] }, tangent: t };
  }
  for (let i = 1; i < points.length; i++) {
    if (s <= seg[i]) {
      const ratio = (s - seg[i - 1]) / Math.max(seg[i] - seg[i - 1], 1e-9);
      return {
        point: {
          x: points[i - 1].x + (points[i].x - points[i - 1].x) * ratio,
          y: points[i - 1].y + (points[i].y - points[i - 1].y) * ratio,
        },
        tangent: tangent(points, i - 1),
      };
    }
  }
  const last = points.length - 1;
  return { point: { ...points[last] }, tangent: tangent(points, last - 1) };
}

function tangent(points: Point[], i: number): Point {
  const a = points[Math.max(0, i)];
  const b = points[Math.min(points.length - 1, i + 1)];
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const norm = Math.hypot(dx, dy) || 1;
  return { x: dx / norm, y: dy / norm };
}

export function laneWidthAt(left: Point[], right: Point[], index: number): number {
  const i = Math.max(0, Math.min(left.length - 1, index));
  return Math.hypot(left[i].x - right[i].x, left[i].y - right[i].y);
}

/** 把 image-px 的点投影到泳道中心线弧长。 */
export function projectToArc(point: Point, line: Point[]): number {
  let bestS = 0;
  let bestD = Infinity;
  const { seg } = cumulativeLength(line);
  for (let i = 1; i < line.length; i++) {
    const a = line[i - 1];
    const b = line[i];
    const vx = b.x - a.x;
    const vy = b.y - a.y;
    const len2 = vx * vx + vy * vy || 1;
    const t = Math.max(0, Math.min(1, ((point.x - a.x) * vx + (point.y - a.y) * vy) / len2));
    const px = a.x + vx * t;
    const py = a.y + vy * t;
    const d = Math.hypot(point.x - px, point.y - py);
    if (d < bestD) {
      bestD = d;
      bestS = seg[i - 1] + t * Math.hypot(vx, vy);
    }
  }
  return bestS;
}
