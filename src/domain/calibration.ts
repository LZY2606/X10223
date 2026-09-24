import type {
  BandMaterial,
  Diagnostic,
  LadderAnchor,
  LadderMaterial,
  LaneCalibration,
  QuantityUnit
} from "./types.js";
import { contentId } from "./ids.js";

interface MatchPair {
  bandIndex: number;
  entryIndex: number;
}

const logValue = (v: number): number => Math.log(v);

interface LineFit {
  a: number;
  b: number;
}

/** 全局稳健直线 logV = a + b*s 的最小二乘拟合（用于残差显示） */
function fitLine(anchors: { s: number; value: number }[]): LineFit {
  const n = anchors.length;
  const sx = anchors.reduce((acc, x) => acc + x.s, 0);
  const sy = anchors.reduce((acc, x) => acc + logValue(x.value), 0);
  const sxx = anchors.reduce((acc, x) => acc + x.s * x.s, 0);
  const sxy = anchors.reduce(
    (acc, x) => acc + x.s * logValue(x.value),
    0
  );
  const den = n * sxx - sx * sx;
  const b = den === 0 ? 0 : (n * sxy - sx * sy) / den;
  const a = n === 0 ? 0 : (sy - b * sx) / n;
  return { a, b };
}

/**
 * ladder 匹配：观察条带（按 s 升序）与标称条目（按 orderFromTop 升序）配对，
 * 允许至多一个缺带；缺带时给出带位置的 ladder_missing_band 诊断，不伪造锚点。
 */
export function matchLadder(
  ladder: LadderMaterial,
  bands: BandMaterial[]
): {
  anchors: LadderAnchor[];
  pairs: MatchPair[];
  diagnostics: Diagnostic[];
  missingEntryId: string | null;
} {
  const diagnostics: Diagnostic[] = [];
  const entries = [...ladder.entries].sort(
    (a, b) => a.orderFromTop - b.orderFromTop
  );
  const observed = [...bands].sort((a, b) => a.s - b.s);
  if (observed.length === 0) {
    return {
      anchors: [],
      pairs: [],
      diagnostics: [
        {
          code: "incomplete_input",
          severity: "error",
          message: "ladder 泳道无任何条带，无法建立标尺",
          location: { laneId: ladder.laneId }
        }
      ],
      missingEntryId: null
    };
  }

  // 标称值非单调：orderFromTop 升序时值必须严格递减
  const nonMonoEntryIds = new Set<string>();
  for (let i = 1; i < entries.length; i++) {
    const prev = entries[i - 1];
    const cur = entries[i];
    if (prev.value === null || cur.value === null) continue;
    if (!(cur.value < prev.value)) nonMonoEntryIds.add(cur.id);
  }

  const tryOffset = (offset: number): MatchPair[] | null => {
    const pairs: MatchPair[] = [];
    for (let i = 0; i < observed.length; i++) {
      const entryIdx = i + offset;
      if (entryIdx >= entries.length) return null;
      if (entries[entryIdx].value === null) return null;
      pairs.push({ bandIndex: i, entryIndex: entryIdx });
    }
    return pairs;
  };

  const scorePairs = (pairs: MatchPair[]): number => {
    const pts = pairs.map((pair) => ({
      s: observed[pair.bandIndex].s,
      value: entries[pair.entryIndex].value as number
    }));
    const { a, b } = fitLine(pts);
    return pts.reduce(
      (acc, pt) => acc + (logValue(pt.value) - (a + b * pt.s)) ** 2,
      0
    );
  };

  const options = [tryOffset(0), tryOffset(1)].filter(
    (p): p is MatchPair[] => p !== null
  );
  let best: MatchPair[] = [];
  if (options.length > 0) {
    best = options
      .map((p) => ({ p, score: scorePairs(p) }))
      .sort((x, y) => x.score - y.score)[0].p;
  }

  const anchors: LadderAnchor[] = best.map((pair) => {
    const band = observed[pair.bandIndex];
    const entry = entries[pair.entryIndex];
    return {
      id: contentId(["anchor", ladder.id, band.id, entry.id]),
      ladderEntryId: entry.id,
      bandId: band.id,
      s: band.s,
      value: entry.value as number,
      unit: entry.unit ?? "bp",
      pixel: band.center,
      monotonicViolation: nonMonoEntryIds.has(entry.id)
    };
  });

  const matchedEntryIds = new Set(
    best.map((p) => entries[p.entryIndex].id)
  );
  let missingEntryId: string | null = null;
  if (observed.length < entries.length) {
    for (const entry of entries) {
      if (matchedEntryIds.has(entry.id)) continue;
      if (entry.value !== null) missingEntryId = entry.id;
      diagnostics.push({
        code: "ladder_missing_band",
        severity: "warning",
        message: `ladder 标称 ${entry.raw}（orderFromTop=${entry.orderFromTop}）在图像上无对应条带：该位置标尺段只能给出缺失诊断，禁止伪造锚点`,
        location: {
          ladderEntryId: entry.id,
          laneId: ladder.laneId
        }
      });
    }
  }
  for (const id of nonMonoEntryIds) {
    const entry = entries.find((e) => e.id === id);
    diagnostics.push({
      code: "ladder_nonmonotonic",
      severity: "error",
      message: `非单调标尺：标称 ${entry?.raw ?? id} 不满足“迁移越大、分子量越小”，相邻插值段失效并限定有效区域`,
      location: { ladderEntryId: id, laneId: ladder.laneId }
    });
  }
  return { anchors, pairs: best, diagnostics, missingEntryId };
}

/** 由锚点构造局部插值段；非单调/缺带相邻对不生成段（局部失效，带原因与有效区域） */
export function buildCalibration(
  laneId: string,
  ladder: LadderMaterial,
  anchors: LadderAnchor[],
  diagnostics: Diagnostic[]
): LaneCalibration {
  const sorted = [...anchors].sort((a, b) => a.s - b.s);
  const segments = [] as LaneCalibration["segments"];
  const invalidIntervals = [] as LaneCalibration["invalidIntervals"];
  const fit = fitLine(sorted);
  const residuals = sorted.map((anchor) => ({
    anchorId: anchor.id,
    residualPx:
      (logValue(anchor.value) - fit.a) / (fit.b === 0 ? 1 : fit.b) - anchor.s
  }));

  for (let i = 0; i < sorted.length - 1; i++) {
    const A = sorted[i];
    const B = sorted[i + 1];
    const monotone =
      !A.monotonicViolation &&
      !B.monotonicViolation &&
      B.value < A.value &&
      B.s > A.s;
    if (monotone) {
      segments.push({
        id: contentId(["segment", A.id, B.id]),
        anchorAId: A.id,
        anchorBId: B.id,
        sMin: A.s,
        sMax: B.s,
        logValueA: logValue(A.value),
        logValueB: logValue(B.value),
        residuals: residuals.filter(
          (r) => r.anchorId === A.id || r.anchorId === B.id
        )
      });
    } else {
      invalidIntervals.push({
        sMin: A.s,
        sMax: B.s,
        reason: "nonmonotonic_or_violating_anchors"
      });
      diagnostics.push({
        code: "ladder_nonmonotonic",
        severity: "error",
        message: `迁移 s∈[${A.s.toFixed(1)}, ${B.s.toFixed(1)}]px 的标尺段非单调或缺带，局部失效`,
        location: { laneId }
      });
    }
  }

  const validRange = segments.length
    ? {
        min: Math.min(...segments.map((g) => g.sMin)),
        max: Math.max(...segments.map((g) => g.sMax))
      }
    : { min: 0, max: 0 };

  return {
    laneId,
    ladderMaterialId: ladder.id,
    anchors: sorted,
    segments,
    validRange,
    invalidIntervals,
    residuals,
    diagnostics
  };
}

export function interpolate(seg: CalibrationSegmentShape, s: number): number {
  const t = (s - seg.sMin) / (seg.sMax - seg.sMin);
  return Math.exp(
    seg.logValueA + (seg.logValueB - seg.logValueA) * t
  );
}

type CalibrationSegmentShape = LaneCalibration["segments"][number];

export function findSegment(
  cal: LaneCalibration,
  s: number,
  tol = 0.5
): CalibrationSegmentShape | null {
  return (
    cal.segments.find((g) => s >= g.sMin - tol && s <= g.sMax + tol) ?? null
  );
}

export function unitOf(cal: LaneCalibration): QuantityUnit {
  return cal.anchors[0]?.unit ?? "bp";
}
