import type {
  Diagnostic,
  LadderNominal,
  MwResult,
  PixelPoint,
  Unit,
} from './types';

export interface LadderPoint {
  key: string;
  y: number; // 迁移坐标（px，已做泳道弯曲校正）
  mw: number;
  logMw: number;
}

export interface RulerBuild {
  status: 'ok' | 'semantic_unsolvable';
  points: LadderPoint[]; // 按迁移坐标升序
  runs: LadderPoint[][]; // 单调段；非单调标尺时 >1，每段各自携带有效区域
  missing: { key: string; mw: number; unit: Unit }[];
  diagnostics: Diagnostic[];
}

export function buildRuler(
  nominals: LadderNominal[],
  centers: Record<string, PixelPoint>,
  laneId: string,
): RulerBuild {
  const diagnostics: Diagnostic[] = [];
  const missing: RulerBuild['missing'] = [];
  const points: LadderPoint[] = [];
  for (const n of [...nominals].sort((a, b) => b.mw - a.mw)) {
    const c = centers[n.key];
    if (!c) {
      missing.push({ key: n.key, mw: n.mw, unit: n.unit });
      diagnostics.push({
        severity: 'warning',
        code: 'LADDER_MISSING_BAND',
        message: `ladder 标称带 ${n.key}（${n.mw} ${n.unit}）缺少像素中心，相关插值段将变宽`,
        position: { laneId, bandKey: n.key },
      });
      continue;
    }
    points.push({ key: n.key, y: c.y, mw: n.mw, logMw: Math.log10(n.mw) });
  }
  points.sort((p, q) => p.y - q.y);

  const runs: LadderPoint[][] = [];
  let current: LadderPoint[] = [];
  let nonMonotonic = false;
  for (const p of points) {
    if (current.length > 0 && p.logMw >= current[current.length - 1].logMw) {
      nonMonotonic = true;
      diagnostics.push({
        severity: 'error',
        code: 'NON_MONOTONIC_RULER',
        message: `标尺非单调：${p.key}（${p.mw}）的迁移位置 y=${p.y.toFixed(1)} px 与更大分子量点矛盾，全局拟合失效，仅保留局部单调段`,
        position: { laneId, bandKey: p.key, pixel: centers[p.key] },
      });
      if (current.length > 0) runs.push(current);
      current = [p];
    } else {
      current.push(p);
    }
  }
  if (current.length > 0) runs.push(current);
  return {
    status: nonMonotonic ? 'semantic_unsolvable' : 'ok',
    points,
    runs,
    missing,
    diagnostics,
  };
}

export function validRegion(run: LadderPoint[]): [number, number] | null {
  if (run.length < 2) return null;
  return [run[0].y, run[run.length - 1].y];
}

export interface RulerFit {
  a: number; // log10(mw) = a + b * y
  b: number;
  residuals: { key: string; residual: number }[];
}

export function fitLinear(points: LadderPoint[]): RulerFit | null {
  if (points.length < 2) return null;
  const n = points.length;
  const sx = points.reduce((s, p) => s + p.y, 0);
  const sy = points.reduce((s, p) => s + p.logMw, 0);
  const sxx = points.reduce((s, p) => s + p.y * p.y, 0);
  const sxy = points.reduce((s, p) => s + p.y * p.logMw, 0);
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) return null;
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  return {
    a,
    b,
    residuals: points.map((p) => ({ key: p.key, residual: p.logMw - (a + b * p.y) })),
  };
}

export function interpolateInRun(
  y: number,
  run: LadderPoint[],
): { mw: number; segment: [LadderPoint, LadderPoint] } | null {
  if (run.length < 2) return null;
  if (y < run[0].y || y > run[run.length - 1].y) return null;
  for (let i = 0; i < run.length - 1; i++) {
    const lo = run[i];
    const hi = run[i + 1];
    if (y >= lo.y && y <= hi.y) {
      const t = hi.y === lo.y ? 0 : (y - lo.y) / (hi.y - lo.y);
      return { mw: Math.pow(10, lo.logMw + t * (hi.logMw - lo.logMw)), segment: [lo, hi] };
    }
  }
  return null;
}

export interface InferOptions {
  method: 'linear' | 'segment';
  fit: RulerFit | null;
  unit: Unit;
}

// 在带有效区域的局部标尺上推断分子量；超出区域只给区间，绝不编造点值。
export function inferMwAt(y: number, build: RulerBuild, opts: InferOptions): MwResult {
  for (const run of build.runs) {
    const region = validRegion(run);
    if (!region || y < region[0] || y > region[1]) continue;
    const hit = interpolateInRun(y, run);
    if (!hit) continue;
    const mw =
      opts.method === 'linear' && opts.fit
        ? Math.pow(10, opts.fit.a + opts.fit.b * y)
        : hit.mw;
    return {
      kind: 'value',
      mw,
      unit: opts.unit,
      segment: {
        lo: { key: hit.segment[0].key, mw: hit.segment[0].mw, y: hit.segment[0].y },
        hi: { key: hit.segment[1].key, mw: hit.segment[1].mw, y: hit.segment[1].y },
      },
      validRegion: region,
      decidedBy: 'auto',
    };
  }
  const all = build.points;
  if (all.length === 0) {
    return { kind: 'interval', lo: null, hi: null, unit: opts.unit, reason: 'no-ladder-points' };
  }
  const minY = all[0].y;
  const maxY = all[all.length - 1].y;
  const maxMw = Math.max(...all.map((p) => p.mw));
  const minMw = Math.min(...all.map((p) => p.mw));
  if (y < minY) {
    return { kind: 'interval', lo: maxMw, hi: null, unit: opts.unit, reason: 'above-ladder-range' };
  }
  if (y > maxY) {
    return { kind: 'interval', lo: null, hi: minMw, unit: opts.unit, reason: 'below-ladder-range' };
  }
  // 落在非单调裂缝中：只能给相邻单调段边界围成的区间
  return {
    kind: 'interval',
    lo: minMw,
    hi: maxMw,
    unit: opts.unit,
    reason: 'non-monotonic-gap',
  };
}

// “微笑”弯曲校正：同一像素高度在不同泳道不等于同一分子量。
// laneCurve 为该泳道等迁移前沿的绝对像素折线；返回 x 处前沿的绝对 y。
export function frontYAt(x: number, curve: PixelPoint[]): number {
  if (curve.length === 0) return 0;
  const sorted = [...curve].sort((a, b) => a.x - b.x);
  let yAt: number;
  if (x <= sorted[0].x) yAt = sorted[0].y;
  else if (x >= sorted[sorted.length - 1].x) yAt = sorted[sorted.length - 1].y;
  else {
    yAt = sorted[sorted.length - 1].y;
    for (let i = 0; i < sorted.length - 1; i++) {
      const p = sorted[i];
      const q = sorted[i + 1];
      if (x >= p.x && x <= q.x) {
        const t = q.x === p.x ? 0 : (x - p.x) / (q.x - p.x);
        yAt = p.y + t * (q.y - p.y);
        break;
      }
    }
  }
  return yAt;
}

export function frontLevel(curve: PixelPoint[]): number {
  if (curve.length === 0) return 0;
  return curve.reduce((s, p) => s + p.y, 0) / curve.length;
}

// 把条带像素高度换算到 ladder 参考前沿下的迁移坐标：
// correctedY = y - (本泳道前沿(x) - ladder 参考前沿)
export function correctMigration(
  y: number,
  x: number,
  curve: PixelPoint[],
  referenceLevel: number,
): number {
  return y - (frontYAt(x, curve) - referenceLevel);
}
