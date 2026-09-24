import type { AnalysisParams, Diagnostic, LaneGeom, Result } from './types';
import { failed, ok } from './types';

export interface LadderPoint {
  r: number;
  bp: number;
}

export interface FittedPoint extends LadderPoint {
  logBp: number;
  predicted: number;
  residual: number;
}

export interface LaneRuler {
  laneId: string;
  fit: 'linear' | 'quadratic';
  coeff: number[];
  validRegion: [number, number];
  points: FittedPoint[];
  monotonic: boolean;
  basis: 'lane-relative-px';
}

export function curveY(lane: LaneGeom, x: number): number {
  return lane.curve.a * x * x + lane.curve.b * x + lane.curve.c;
}

export function correctR(lane: LaneGeom, xPx: number, yPx: number): number {
  return yPx - curveY(lane, xPx);
}

function solve3(m: number[][]): number[] | null {
  const n = m.length;
  const a = m.map((row) => row.slice());
  for (let col = 0; col < n; col++) {
    let piv = col;
    for (let r = col + 1; r < n; r++) {
      if (Math.abs(a[r]![col]!) > Math.abs(a[piv]![col]!)) piv = r;
    }
    if (Math.abs(a[piv]![col]!) < 1e-12) return null;
    const tmp = a[col]!;
    a[col] = a[piv]!;
    a[piv] = tmp;
    for (let r = 0; r < n; r++) {
      if (r === col) continue;
      const f = a[r]![col]! / a[col]![col]!;
      for (let c = 0; c <= n; c++) a[r]![c] = a[r]![c]! - f * a[col]![c]!;
    }
  }
  return a.map((row, i) => row[n]! / a[i]![i]!);
}

export function fitLaneRuler(
  laneId: string,
  points: LadderPoint[],
  params: AnalysisParams,
): Result<LaneRuler> {
  const diagnostics: Diagnostic[] = [];
  const sorted = [...points].sort((p, q) => p.r - q.r);
  const deg = params.fit === 'quadratic' ? 2 : 1;
  const need = deg + 2;
  if (sorted.length < need) {
    return failed('SEMANTIC_UNSOLVABLE', [
      {
        code: 'RULER_POINTS_INSUFFICIENT',
        message: `泳道 ${laneId} 的 ladder 点不足（${sorted.length} < ${need}），无法拟合局部标尺`,
        location: `ruler.${laneId}`,
        severity: 'error',
      },
    ]);
  }
  const xs = sorted.map((p) => p.r);
  const ys = sorted.map((p) => Math.log10(p.bp));
  const size = deg + 1;
  const ata: number[][] = Array.from({ length: size }, () => new Array<number>(size + 1).fill(0));
  for (let i = 0; i < xs.length; i++) {
    const powers: number[] = [];
    for (let d = 0; d <= deg; d++) powers.push(Math.pow(xs[i]!, d));
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) ata[r]![c]! += powers[r]! * powers[c]!;
      ata[r]![size]! += powers[r]! * ys[i]!;
    }
  }
  const coeff = solve3(ata);
  if (!coeff) {
    return failed('SEMANTIC_UNSOLVABLE', [
      {
        code: 'RULER_SINGULAR',
        message: `泳道 ${laneId} 的标尺拟合矩阵奇异`,
        location: `ruler.${laneId}`,
        severity: 'error',
      },
    ]);
  }
  const predict = (r: number): number => {
    let v = 0;
    for (let d = 0; d <= deg; d++) v += coeff[d]! * Math.pow(r, d);
    return v;
  };
  const validRegion: [number, number] = [xs[0]!, xs[xs.length - 1]!];
  let monotonic = true;
  if (deg === 1) {
    monotonic = coeff[1]! < 0;
  } else {
    const steps = 32;
    for (let i = 0; i <= steps; i++) {
      const r = validRegion[0] + ((validRegion[1] - validRegion[0]) * i) / steps;
      const deriv = coeff[1]! + 2 * coeff[2]! * r;
      if (deriv >= 0) {
        monotonic = false;
        break;
      }
    }
  }
  if (!monotonic) {
    return failed('SEMANTIC_UNSOLVABLE', [
      {
        code: 'RULER_NON_MONOTONIC',
        message: `泳道 ${laneId} 的标尺在有效区域内非单调，分子量映射不唯一`,
        location: `ruler.${laneId}`,
        severity: 'error',
      },
    ]);
  }
  const fitted: FittedPoint[] = sorted.map((p) => {
    const logBp = Math.log10(p.bp);
    const predicted = predict(p.r);
    return { ...p, logBp, predicted, residual: logBp - predicted };
  });
  const ruler: LaneRuler = {
    laneId,
    fit: params.fit,
    coeff,
    validRegion,
    points: fitted,
    monotonic,
    basis: 'lane-relative-px',
  };
  return ok(ruler, diagnostics);
}

export interface BpEstimate {
  bp: number;
  logBp: number;
  withinValidRegion: boolean;
  diagnostic: Diagnostic | null;
}

export function inferBp(
  ruler: LaneRuler,
  r: number,
  params: AnalysisParams,
  location: string,
): BpEstimate | { rejected: true; diagnostic: Diagnostic } {
  const within = r >= ruler.validRegion[0] && r <= ruler.validRegion[1];
  if (!within && params.extrapolation === 'refuse') {
    return {
      rejected: true,
      diagnostic: {
        code: 'OUT_OF_VALID_REGION',
        message: `迁移位置 r=${r.toFixed(1)}px 超出局部标尺有效区域 [${ruler.validRegion[0].toFixed(1)}, ${ruler.validRegion[1].toFixed(1)}]px，拒绝外推`,
        location,
        severity: 'error',
      },
    };
  }
  let logBp = 0;
  for (let d = 0; d < ruler.coeff.length; d++) logBp += ruler.coeff[d]! * Math.pow(r, d);
  const diagnostic: Diagnostic | null = within
    ? null
    : {
        code: 'EXTRAPOLATED_VALUE',
        message: `r=${r.toFixed(1)}px 超出有效区域，值被标记为外推`,
        location,
        severity: 'warning',
      };
  return { bp: Math.pow(10, logBp), logBp, withinValidRegion: within, diagnostic };
}
