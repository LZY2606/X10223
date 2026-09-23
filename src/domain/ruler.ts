import type { Result, Diagnostic } from "./diagnostics.ts";
import { ok, fail, diag } from "./diagnostics.ts";

export interface LadderPoint {
  d: number;   // migration distance in px, basis image-norm
  mw: number;  // nominal size in bp
}

export interface Ruler {
  a: number;             // log10(mw) = a + b*d
  b: number;
  dMin: number;          // validity region in px (local ruler!)
  dMax: number;
  points: LadderPoint[];
  residuals: number[];   // per-point residual in log10(bp)
}

/**
 * Fit a local log-linear ruler from ladder points.
 * A non-monotonic ladder (sizes not strictly decreasing with distance) is a
 * semantic failure: the mapping cannot be a function, so we refuse with
 * `semantic_unsolvable` rather than silently fitting garbage.
 */
export function fitRuler(points: LadderPoint[], path: string): Result<Ruler> {
  const diagnostics: Diagnostic[] = [];
  if (points.length < 2) {
    return fail("semantic_unsolvable", [diag("ruler-too-few-points", `need >=2 ladder points, got ${points.length}`, path)]);
  }
  const sorted = [...points].sort((p, q) => p.d - q.d);
  for (let i = 1; i < sorted.length; i++) {
    if (!(sorted[i].mw < sorted[i - 1].mw)) {
      return fail("semantic_unsolvable", [
        diag("ruler-non-monotonic",
          `ladder not monotonic: d=${sorted[i - 1].d}px -> ${sorted[i - 1].mw}bp then d=${sorted[i].d}px -> ${sorted[i].mw}bp`,
          `${path}/${i}`),
      ]);
    }
  }
  const n = sorted.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (const p of sorted) {
    const ly = Math.log10(p.mw);
    sx += p.d; sy += ly; sxx += p.d * p.d; sxy += p.d * ly;
  }
  const denom = n * sxx - sx * sx;
  if (Math.abs(denom) < 1e-12) {
    return fail("semantic_unsolvable", [diag("ruler-degenerate", "all ladder points at same migration distance", path)]);
  }
  const b = (n * sxy - sx * sy) / denom;
  const a = (sy - b * sx) / n;
  if (!(b < 0)) {
    return fail("semantic_unsolvable", [diag("ruler-non-monotonic", `fitted slope b=${b} is not negative`, path)]);
  }
  const residuals = sorted.map((p) => a + b * p.d - Math.log10(p.mw));
  return ok({ a, b, dMin: sorted[0].d, dMax: sorted[n - 1].d, points: sorted, residuals }, diagnostics);
}

export type RulerEval =
  | { kind: "point"; logMw: number; mw: number }
  | { kind: "interval"; lo: number; hi: number; reason: string };

/** Evaluate the ruler; outside the validity region only an interval is returned. */
export function evalRuler(ruler: Ruler, d: number): RulerEval {
  if (d < ruler.dMin || d > ruler.dMax) {
    const edge = d < ruler.dMin ? ruler.dMin : ruler.dMax;
    const logAt = ruler.a + ruler.b * edge;
    // extrapolation is only a bound, never a point estimate
    const logHere = ruler.a + ruler.b * d;
    const lo = Math.pow(10, Math.min(logAt, logHere));
    const hi = Math.pow(10, Math.max(logAt, logHere));
    return { kind: "interval", lo, hi, reason: "outside-validity-region" };
  }
  const logMw = ruler.a + ruler.b * d;
  return { kind: "point", logMw, mw: Math.pow(10, logMw) };
}
