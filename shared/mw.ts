// 分子量标尺：局部（分段）对数线性插值、单调性检验、有效区间。
// “微笑”弯曲使同一高度不等于同一分子量，因此标尺必须携带有效区域。

export interface RulerPoint {
  id: string;   // ladder 条带材料 stream id（稳定身份）
  d: number;    // 校正后迁移距离（像素，规范坐标基）
  mw: number;   // 标称分子量
}

export interface RulerSegment {
  p0: RulerPoint;
  p1: RulerPoint;
  violated: boolean; // 非单调：mw 未随 d 严格下降
}

export interface Ruler {
  points: RulerPoint[];          // 按 d 升序
  segments: RulerSegment[];
  dMin: number;
  dMax: number;
}

export function buildRuler(points: RulerPoint[]): Ruler {
  const sorted = [...points].sort((a, b) => (a.d - b.d) || a.id.localeCompare(b.id));
  const segments: RulerSegment[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    segments.push({
      p0: sorted[i],
      p1: sorted[i + 1],
      violated: sorted[i + 1].mw >= sorted[i].mw
    });
  }
  return {
    points: sorted,
    segments,
    dMin: sorted[0]?.d ?? 0,
    dMax: sorted[sorted.length - 1]?.d ?? 0
  };
}

export type Interpolation =
  | { kind: 'point'; mw: number; logMw: number; segment: RulerSegment }
  | { kind: 'below'; bound: RulerPoint }   // d < dMin：分子量高于最大标称
  | { kind: 'above'; bound: RulerPoint };  // d > dMax：分子量低于最小标称

export function interpolateLog(ruler: Ruler, d: number): Interpolation {
  const pts = ruler.points;
  if (d < ruler.dMin) return { kind: 'below', bound: pts[0] };
  if (d > ruler.dMax) return { kind: 'above', bound: pts[pts.length - 1] };
  for (const seg of ruler.segments) {
    if (d >= seg.p0.d && d <= seg.p1.d) {
      const t = seg.p1.d === seg.p0.d ? 0 : (d - seg.p0.d) / (seg.p1.d - seg.p0.d);
      const logMw = Math.log10(seg.p0.mw) + t * (Math.log10(seg.p1.mw) - Math.log10(seg.p0.mw));
      return { kind: 'point', mw: Math.pow(10, logMw), logMw, segment: seg };
    }
  }
  return { kind: 'point', mw: pts[pts.length - 1].mw, logMw: Math.log10(pts[pts.length - 1].mw), segment: ruler.segments[ruler.segments.length - 1] };
}

/** 全局对数线性拟合（仅用于拟合残差展示；分子量推断使用局部插值）。 */
export function globalLogFit(points: RulerPoint[]): { alpha: number; beta: number; residuals: Map<string, number> } {
  const n = points.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of points) {
    const y = Math.log10(p.mw);
    sx += p.d; sy += y; sxx += p.d * p.d; sxy += p.d * y;
  }
  const denom = n * sxx - sx * sx || 1;
  const beta = (n * sxy - sx * sy) / denom;
  const alpha = (sy - beta * sx) / n;
  const residuals = new Map<string, number>();
  for (const p of points) residuals.set(p.id, Math.log10(p.mw) - (alpha + beta * p.d));
  return { alpha, beta, residuals };
}

/** 最小二乘：log10(mw) = a + b*y，用于 ladder 缺带匹配假设评分。 */
export function leastSquaresLogMw(pairs: { y: number; mw: number }[]): { a: number; b: number; sse: number } {
  const n = pairs.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of pairs) {
    const lw = Math.log10(p.mw);
    sx += p.y; sy += lw; sxx += p.y * p.y; sxy += p.y * lw;
  }
  const denom = n * sxx - sx * sx || 1e-12;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  let sse = 0;
  for (const p of pairs) {
    const r = Math.log10(p.mw) - (a + b * p.y);
    sse += r * r;
  }
  return { a, b, sse };
}

/** 生成 C(n, k) 的全部保序组合（用于 ladder 缺带假设枚举）。 */
export function* combinations(n: number, k: number): Generator<number[]> {
  const idx = Array.from({ length: k }, (_, i) => i);
  while (true) {
    yield [...idx];
    let i = k - 1;
    while (i >= 0 && idx[i] === n - k + i) i--;
    if (i < 0) return;
    idx[i]++;
    for (let j = i + 1; j < k; j++) idx[j] = idx[j - 1] + 1;
  }
}

export function combinationCount(n: number, k: number): number {
  if (k < 0 || k > n) return 0;
  let r = 1;
  for (let i = 0; i < k; i++) r = (r * (n - i)) / (i + 1);
  return Math.round(r);
}
