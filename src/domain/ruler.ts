import { diag, type Diagnostic } from './units';
import { stableId } from './ids';

/** Local ruler: piecewise log-linear interpolation between ladder anchors.
 *  Every segment carries an explicit validity region in normalized px. */

export interface RulerParams {
  version: string;
  method: 'log-linear';
  smileCorrection: boolean;
  gapRatioThreshold: number; // spacing ratio that signals a suspected ladder gap
}

export const DEFAULT_RULER_PARAMS: RulerParams = {
  version: 'ruler-v1',
  method: 'log-linear',
  smileCorrection: true,
  gapRatioThreshold: 1.8,
};

export interface AnchorPoint {
  ref: string; // provenance: "<ladderMaterialId>#<bandIndex>"
  bandIndex: number;
  bp: number;
  yPx: number; // normalized frame
}

export interface RulerSegment {
  id: string;
  laneId: string;
  yTopPx: number;
  yBottomPx: number;
  bpTop: number; // larger bp at smaller y
  bpBottom: number;
  anchorTopRef: string;
  anchorBottomRef: string;
  valid: boolean;
  invalidReason?: string;
}

export interface LocalRuler {
  laneId: string;
  smileOffsetPx: number;
  segments: RulerSegment[];
  diagnostics: Diagnostic[];
}

export interface LaneGeom {
  laneId: string;
  xCenter: number;
}

function buildSegments(laneId: string, anchors: AnchorPoint[], smileOffsetPx: number): { segments: RulerSegment[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const sorted = [...anchors].sort((a, b) => a.yPx - b.yPx);
  const segments: RulerSegment[] = [];
  for (let i = 0; i + 1 < sorted.length; i++) {
    const top = sorted[i];
    const bottom = sorted[i + 1];
    const seg: RulerSegment = {
      id: stableId('seg', { laneId, top: top.ref, bottom: bottom.ref, yTop: top.yPx, yBottom: bottom.yPx }),
      laneId,
      yTopPx: top.yPx,
      yBottomPx: bottom.yPx,
      bpTop: top.bp,
      bpBottom: bottom.bp,
      anchorTopRef: top.ref,
      anchorBottomRef: bottom.ref,
      valid: true,
    };
    if (!(top.bp > bottom.bp)) {
      seg.valid = false;
      seg.invalidReason = 'non-monotonic-ruler';
      diagnostics.push(
        diag(
          'non-monotonic-ruler',
          `ladder 标称值随迁移距离非单调：${top.bp}bp@${top.yPx.toFixed(1)}px -> ${bottom.bp}bp@${bottom.yPx.toFixed(1)}px`,
          'error',
          { lane: laneId, band: bottom.bandIndex, yPx: bottom.yPx },
        ),
      );
    }
    segments.push(seg);
  }
  // suspected missing ladder band: abnormally large spacing vs local log-spacing
  for (let i = 0; i < segments.length; i++) {
    const s = segments[i];
    const span = Math.log10(s.bpTop) - Math.log10(s.bpBottom);
    const neighbors = [segments[i - 1], segments[i + 1]].filter(Boolean) as RulerSegment[];
    if (neighbors.length === 0) continue;
    const localSpan =
      neighbors.reduce((acc, n) => acc + (Math.log10(n.bpTop) - Math.log10(n.bpBottom)), 0) / neighbors.length;
    if (localSpan > 0 && span / localSpan > DEFAULT_RULER_PARAMS.gapRatioThreshold) {
      diagnostics.push(
        diag(
          'ladder-gap-suspected',
          `ladder 疑似缺带：${s.bpTop}bp 与 ${s.bpBottom}bp 之间对数间距 ${span.toFixed(3)} 超过局部均值 ${localSpan.toFixed(3)} 的 ${DEFAULT_RULER_PARAMS.gapRatioThreshold} 倍`,
          'warning',
          { lane: laneId, yPx: (s.yTopPx + s.yBottomPx) / 2 },
        ),
      );
    }
  }
  void smileOffsetPx;
  return { segments, diagnostics };
}

/** Build one local ruler per lane. With two ladder lanes, anchors are shifted by a
 *  per-lane smile offset interpolated between the ladders ("微笑" correction). */
export function buildLocalRulers(args: {
  ladderA: { laneId: string; xCenter: number; anchors: AnchorPoint[] };
  ladderB: { laneId: string; xCenter: number; anchors: AnchorPoint[] } | null;
  lanes: LaneGeom[];
  params: RulerParams;
}): Map<string, LocalRuler> {
  const { ladderA, ladderB, lanes, params } = args;
  const out = new Map<string, LocalRuler>();
  const bByIndex = new Map<number, AnchorPoint>();
  if (ladderB) for (const a of ladderB.anchors) bByIndex.set(a.bandIndex, a);
  for (const lane of lanes) {
    const diagnostics: Diagnostic[] = [];
    let t = 0;
    if (ladderB && params.smileCorrection) {
      t = (lane.xCenter - ladderA.xCenter) / (ladderB.xCenter - ladderA.xCenter);
    } else if (ladderB && !params.smileCorrection) {
      diagnostics.push(
        diag('smile-correction-off', '微笑校正已关闭：所有泳道共用 ladder A 的全局标尺', 'warning', { lane: lane.laneId }),
      );
    } else if (!ladderB) {
      diagnostics.push(
        diag('single-ladder', '只有单条 ladder，无法估计泳道弯曲；使用全局标尺', 'warning', { lane: lane.laneId }),
      );
    }
    const anchors: AnchorPoint[] = ladderA.anchors.map((a) => {
      const b = bByIndex.get(a.bandIndex);
      const yPx = b ? a.yPx + (b.yPx - a.yPx) * t : a.yPx;
      return { ...a, yPx };
    });
    const smileOffsetPx =
      ladderB && params.smileCorrection
        ? ladderA.anchors.reduce((acc, a) => {
            const b = bByIndex.get(a.bandIndex);
            return acc + (b ? (b.yPx - a.yPx) * t : 0);
          }, 0) / Math.max(1, ladderA.anchors.length)
        : 0;
    const { segments, diagnostics: segDiags } = buildSegments(lane.laneId, anchors, smileOffsetPx);
    out.set(lane.laneId, { laneId: lane.laneId, smileOffsetPx, segments, diagnostics: [...diagnostics, ...segDiags] });
  }
  return out;
}

export function interpolateBp(seg: RulerSegment, yPx: number): number {
  const logTop = Math.log10(seg.bpTop);
  const logBottom = Math.log10(seg.bpBottom);
  const f = (yPx - seg.yTopPx) / (seg.yBottomPx - seg.yTopPx);
  return Math.pow(10, logTop + (logBottom - logTop) * f);
}

export function findSegment(ruler: LocalRuler, yPx: number): RulerSegment | undefined {
  return ruler.segments.find((s) => yPx >= s.yTopPx && yPx <= s.yBottomPx);
}

export function findAnySegment(ruler: LocalRuler, yPx: number): RulerSegment | undefined {
  return ruler.segments.find((s) => yPx >= s.yTopPx && yPx <= s.yBottomPx + 1e-9);
}

/** Leave-one-out residuals of ladder anchors against a log-linear fit of the rest. */
export function anchorResiduals(anchors: AnchorPoint[]): { ref: string; bandIndex: number; residualPx: number }[] {
  const res: { ref: string; bandIndex: number; residualPx: number }[] = [];
  for (let i = 0; i < anchors.length; i++) {
    const rest = anchors.filter((_, j) => j !== i);
    if (rest.length < 2) break;
    const xs = rest.map((a) => Math.log10(a.bp));
    const ys = rest.map((a) => a.yPx);
    const n = rest.length;
    const mx = xs.reduce((a, b) => a + b, 0) / n;
    const my = ys.reduce((a, b) => a + b, 0) / n;
    let sxy = 0;
    let sxx = 0;
    for (let k = 0; k < n; k++) {
      sxy += (xs[k] - mx) * (ys[k] - my);
      sxx += (xs[k] - mx) * (xs[k] - mx);
    }
    if (sxx === 0) continue;
    const slope = sxy / sxx;
    const intercept = my - slope * mx;
    const predicted = slope * Math.log10(anchors[i].bp) + intercept;
    res.push({ ref: anchors[i].ref, bandIndex: anchors[i].bandIndex, residualPx: anchors[i].yPx - predicted });
  }
  return res;
}
