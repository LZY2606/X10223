import { Diagnostic, Outcome, ok, unsolvable } from './result.js';
import { PxRegion, Quantity, parseNominal } from './units.js';

export interface LadderInputPoint {
  /** pixel y of the detected ladder band, in image-px of the ladder image */
  y: number;
  /** raw nominal value exactly as imported, e.g. "10 kb", "500 bp", "unknown" */
  raw: string;
}

export interface RulerPoint {
  index: number;
  y: number;
  raw: string; // original representation preserved
  mw: Quantity | null; // null when unconvertible; value stays raw + diagnostic
  logMw: number | null;
}

export interface RulerSegment {
  index: number;
  y0: number;
  y1: number;
  logMw0: number;
  logMw1: number;
  /** true when this segment bridges a missing ladder band */
  gap: boolean;
}

export interface Ruler {
  laneId: string;
  imageId: string;
  points: RulerPoint[];
  segments: RulerSegment[];
  /** local ruler MUST carry its valid region: outside it, no point estimates */
  validRegion: PxRegion;
  diagnostics: Diagnostic[];
}

export interface RulerParams {
  /** spacing ratio above which a gap (missing ladder band) is declared */
  gapSpacingRatio: number;
}

export const RULER_PARAM_VERSION = 'ruler.loglinear.v1';

/**
 * Build a piecewise log-linear ruler (log10 MW vs pixel y) from ladder points.
 * Non-monotonic ladders are semantically unsolvable, never silently reordered.
 */
export function buildRuler(
  laneId: string,
  imageId: string,
  inputs: LadderInputPoint[],
  params: RulerParams,
): Outcome<Ruler> {
  const diagnostics: Diagnostic[] = [];
  if (inputs.length < 2) {
    return unsolvable({
      code: 'LADDER_TOO_SPARSE',
      message: `ladder lane ${laneId} has ${inputs.length} usable points, need >= 2`,
      at: { laneId },
    });
  }
  // stable order: sort by pixel y (migration front). Equivalent input -> stable order.
  const sorted = [...inputs].sort((a, b) => a.y - b.y);
  const points: RulerPoint[] = sorted.map((p, index) => {
    const mw = parseNominal(p.raw);
    if (mw === null) {
      diagnostics.push({
        code: 'NOMINAL_UNCONVERTIBLE',
        message: `nominal "${p.raw}" kept raw at position; cannot normalize`,
        at: { laneId, bandIndex: index, y: p.y },
      });
      return { index, y: p.y, raw: p.raw, mw: null, logMw: null };
    }
    if (mw.value <= 0) {
      diagnostics.push({
        code: 'NOMINAL_NONPOSITIVE',
        message: `nominal "${p.raw}" is non-positive; excluded from fit`,
        at: { laneId, bandIndex: index, y: p.y },
      });
      return { index, y: p.y, raw: p.raw, mw: null, logMw: null };
    }
    return { index, y: p.y, raw: p.raw, mw, logMw: Math.log10(mw.value) };
  });

  const usable = points.filter((p) => p.logMw !== null);
  if (usable.length < 2) {
    return unsolvable({
      code: 'LADDER_TOO_SPARSE',
      message: `ladder lane ${laneId} has ${usable.length} convertible points, need >= 2`,
      at: { laneId },
    });
  }
  // monotonicity: as y increases, log10(MW) must strictly decrease
  for (let i = 1; i < usable.length; i++) {
    const prev = usable[i - 1]!;
    const cur = usable[i]!;
    if (cur.y <= prev.y) {
      return unsolvable({
        code: 'NON_MONOTONIC_RULER',
        message: `duplicate pixel y between ladder points ${prev.index} and ${cur.index}`,
        at: { laneId, bandIndex: cur.index, y: cur.y },
      });
    }
    if (cur.logMw! >= prev.logMw!) {
      return unsolvable({
        code: 'NON_MONOTONIC_RULER',
        message: `log10(MW) does not strictly decrease between ladder points ${prev.index} (y=${prev.y}) and ${cur.index} (y=${cur.y})`,
        at: { laneId, bandIndex: cur.index, y: cur.y },
      });
    }
  }

  // gap detection: spacing between consecutive points much larger than median spacing
  const spacings: number[] = [];
  for (let i = 1; i < usable.length; i++) spacings.push(usable[i]!.y - usable[i - 1]!.y);
  const sortedSp = [...spacings].sort((a, b) => a - b);
  const median = sortedSp[Math.floor(sortedSp.length / 2)]!;
  const segments: RulerSegment[] = [];
  for (let i = 1; i < usable.length; i++) {
    const a = usable[i - 1]!;
    const b = usable[i]!;
    const gap = b.y - a.y > params.gapSpacingRatio * median;
    if (gap) {
      diagnostics.push({
        code: 'MISSING_LADDER_BAND',
        message: `spacing ${(b.y - a.y).toFixed(1)}px between ladder points ${a.index} and ${b.index} exceeds ${params.gapSpacingRatio}x median; segment flagged as gap`,
        at: { laneId, bandIndex: b.index, y: b.y },
      });
    }
    segments.push({ index: i - 1, y0: a.y, y1: b.y, logMw0: a.logMw!, logMw1: b.logMw!, gap });
  }

  const validRegion: PxRegion = {
    yMin: usable[0]!.y,
    yMax: usable[usable.length - 1]!.y,
    space: 'image-px',
    imageId,
    laneId,
  };
  return ok({ laneId, imageId, points, segments, validRegion, diagnostics }, diagnostics);
}

export type Estimate =
  | { status: 'point'; mw: Quantity; segmentIndex: number }
  | { status: 'out-of-range'; direction: 'above' | 'below'; bound: Quantity }
  | { status: 'unsolvable'; reason: string };

/** Interpolate log10(MW) at pixel y. Outside the valid region there is no point estimate. */
export function estimateAt(ruler: Ruler, y: number): Estimate {
  const { validRegion } = ruler;
  if (y < validRegion.yMin) {
    const top = ruler.points.find((p) => p.logMw !== null)!;
    return { status: 'out-of-range', direction: 'above', bound: top.mw! };
  }
  if (y > validRegion.yMax) {
    const usable = ruler.points.filter((p) => p.logMw !== null);
    const bottom = usable[usable.length - 1]!;
    return { status: 'out-of-range', direction: 'below', bound: bottom.mw! };
  }
  for (const seg of ruler.segments) {
    if (y >= seg.y0 && y <= seg.y1) {
      const t = (y - seg.y0) / (seg.y1 - seg.y0);
      const logMw = seg.logMw0 + t * (seg.logMw1 - seg.logMw0);
      const unit = ruler.points.find((p) => p.logMw !== null)!.mw!.unit;
      return { status: 'point', mw: { value: Math.pow(10, logMw), unit }, segmentIndex: seg.index };
    }
  }
  return { status: 'unsolvable', reason: `no segment covers y=${y}` };
}

/** residuals of the ladder fit, in log10(MW), per ladder point */
export function fitResiduals(ruler: Ruler): { index: number; y: number; residualLogMw: number }[] {
  const out: { index: number; y: number; residualLogMw: number }[] = [];
  for (const p of ruler.points) {
    if (p.logMw === null) continue;
    const est = estimateAt(ruler, p.y);
    if (est.status === 'point') {
      out.push({ index: p.index, y: p.y, residualLogMw: Math.log10(est.mw.value) - p.logMw });
    }
  }
  return out;
}
