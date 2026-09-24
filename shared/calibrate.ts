import type { ComputeResult, Diagnostic } from "./types.js";
import { ok, fail } from "./types.js";

/** ladder 锚点：像素 y（图像坐标基准）+ 标称分子量（bp）。 */
export interface LadderAnchor {
  y: number;
  bp: number;
}

export type SegmentStatus = "ok" | "degraded" | "unsolvable";

/** 局部标尺插值段：log10(bp) = slope*y + intercept，仅在 [yMin, yMax] 有效。 */
export interface RulerSegment {
  index: number;
  yMin: number;
  yMax: number;
  bpAtYMin: number;
  bpAtYMax: number;
  slope: number;
  intercept: number;
  status: SegmentStatus;
  reason?: string;
}

export interface LaneRuler {
  laneIndex: number;
  anchors: LadderAnchor[];
  segments: RulerSegment[];
  validRegion: { yMin: number; yMax: number } | null;
  unit: "bp";
  basis: "image-px";
}

export interface RulerGap {
  expectedY: number;
  missingBp: number;
}

/**
 * 构建泳道局部标尺。
 * - 标称值随 y 必须严格递减，违反的插值段标为 unsolvable（语义无解）；
 * - 缺带位置所在的段标为 degraded；
 * - 有效区域 = 首末锚点之间，区域外不得给值。
 */
export function buildRuler(
  laneIndex: number,
  anchors: LadderAnchor[],
  gaps: RulerGap[] = [],
): ComputeResult<LaneRuler> {
  const diagnostics: Diagnostic[] = [];
  const sorted = [...anchors].sort((a, b) => a.y - b.y);
  const segments: RulerSegment[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    const seg: RulerSegment = {
      index: i,
      yMin: a.y,
      yMax: b.y,
      bpAtYMin: a.bp,
      bpAtYMax: b.bp,
      slope: 0,
      intercept: 0,
      status: "ok",
    };
    if (!(a.bp > b.bp)) {
      seg.status = "unsolvable";
      seg.reason = "non-monotonic-ruler";
      diagnostics.push({
        code: "non-monotonic-ruler",
        severity: "error",
        message: `ladder 标称值非单调：y=${a.y} 处 ${a.bp}bp，y=${b.y} 处 ${b.bp}bp`,
        location: { path: "ruler.segments", laneIndex, segmentIndex: i, y: b.y, bp: b.bp },
      });
    } else {
      const l1 = Math.log10(a.bp);
      const l2 = Math.log10(b.bp);
      seg.slope = (l2 - l1) / (b.y - a.y);
      seg.intercept = l1 - seg.slope * a.y;
    }
    segments.push(seg);
  }
  for (const gap of gaps) {
    const seg = segments.find((s) => gap.expectedY >= s.yMin && gap.expectedY <= s.yMax);
    if (seg && seg.status === "ok") {
      seg.status = "degraded";
      seg.reason = `ladder-band-missing:${gap.missingBp}`;
      diagnostics.push({
        code: "ladder-band-missing",
        severity: "warning",
        message: `ladder 缺带 ${gap.missingBp}bp，跨越缺口的插值段降级`,
        location: { path: "ruler.segments", laneIndex, segmentIndex: seg.index, expectedY: gap.expectedY, missingBp: gap.missingBp },
      });
    }
  }
  const usable = segments.filter((s) => s.status !== "unsolvable");
  if (sorted.length < 2 || usable.length === 0) {
    return fail("unsolvable", [
      ...diagnostics,
      {
        code: "ruler-unsolvable",
        severity: "error",
        message: "局部标尺无任何可用插值段",
        location: { path: "ruler", laneIndex },
      },
    ]);
  }
  const ruler: LaneRuler = {
    laneIndex,
    anchors: sorted,
    segments,
    validRegion: { yMin: sorted[0].y, yMax: sorted[sorted.length - 1].y },
    unit: "bp",
    basis: "image-px",
  };
  return ok(ruler, diagnostics);
}

export type BpEstimate =
  | { kind: "point"; bp: number; log10Bp: number; segmentIndex: number; degraded: boolean }
  | { kind: "out-of-region"; diagnostic: Diagnostic }
  | { kind: "unsolvable-segment"; diagnostic: Diagnostic };

/** 在局部标尺上估计 y 处的分子量；超出有效区域不给值。 */
export function estimateBp(ruler: LaneRuler, y: number): BpEstimate {
  const seg = ruler.segments.find((s) => y >= s.yMin && y <= s.yMax);
  if (!seg) {
    return {
      kind: "out-of-region",
      diagnostic: {
        code: "out-of-valid-region",
        severity: "error",
        message: `y=${y} 超出局部标尺有效区域 [${ruler.validRegion?.yMin}, ${ruler.validRegion?.yMax}]`,
        location: { path: "ruler.estimate", laneIndex: ruler.laneIndex, y },
      },
    };
  }
  if (seg.status === "unsolvable") {
    return {
      kind: "unsolvable-segment",
      diagnostic: {
        code: "unsolvable-segment",
        severity: "error",
        message: `插值段 ${seg.index} 语义无解（${seg.reason}）`,
        location: { path: "ruler.estimate", laneIndex: ruler.laneIndex, segmentIndex: seg.index, y },
      },
    };
  }
  const log10Bp = seg.slope * y + seg.intercept;
  return {
    kind: "point",
    bp: Math.round(10 ** log10Bp),
    log10Bp,
    segmentIndex: seg.index,
    degraded: seg.status === "degraded",
  };
}

/** ladder 锚点残差：log10(bp) 对 y 的最小二乘拟合。 */
export function fitResiduals(anchors: LadderAnchor[]): {
  a: number;
  b: number;
  residuals: { y: number; bp: number; residual: number }[];
} {
  const n = anchors.length;
  const xs = anchors.map((p) => p.y);
  const ys = anchors.map((p) => Math.log10(p.bp));
  const mx = xs.reduce((s, v) => s + v, 0) / n;
  const my = ys.reduce((s, v) => s + v, 0) / n;
  let sxx = 0;
  let sxy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
  }
  const a = sxx === 0 ? 0 : sxy / sxx;
  const b = my - a * mx;
  return {
    a,
    b,
    residuals: anchors.map((p, i) => ({
      y: p.y,
      bp: p.bp,
      residual: ys[i] - (a * p.y + b),
    })),
  };
}
