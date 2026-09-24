// 局部标尺：每 lane 独立的 log(Mw)–s 分段线性插值 + 有效区域 + 拟合残差。
import type { Diagnostic, LadderRung, GelParams } from "./types";
import { alignLadder, type ObservedBandLite } from "./ladder";
import type { CalibrationResult, RulerSegment, RungResidual, DetectedRungView } from "./artifacts";

export interface CalibrateArgs {
  laneId: string;
  ladderSpecId: string;
  rungs: LadderRung[];
  observed: ObservedBandLite[];
  arcLength: number;
  params: GelParams;
}

export type CalibrationCore = Omit<CalibrationResult, "id" | "adopted" | "inputSummary" | "parentIds">;

function linearFit(xs: number[], ys: number[]): { slope: number; intercept: number; r2: number } {
  const n = xs.length;
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxx = 0;
  let sxy = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxx += (xs[i] - mx) ** 2;
    sxy += (xs[i] - mx) * (ys[i] - my);
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxy / (sxx || 1);
  const intercept = my - slope * mx;
  const ssRes = ys.reduce((acc, y, i) => acc + (y - (intercept + slope * xs[i])) ** 2, 0);
  const r2 = syy === 0 ? 1 : Math.max(0, 1 - ssRes / syy);
  return { slope, intercept, r2 };
}

export function computeResiduals(matchedInput: DetectedRungView[]): RungResidual[] {
  const matched: (DetectedRungView & { s: number })[] = matchedInput
    .filter((r) => r.s !== null)
    .map((r) => ({ ...r, s: r.s as number }));
  if (matched.length < 3) {
    return matched.map((r) => ({ order: r.order, label: r.label, sObserved: r.s, sPredicted: r.s, residualPx: 0 }));
  }
  return matched.map((held, k) => {
    const others = matched.filter((_, i) => i !== k);
    const fit = linearFit(
      others.map((r) => r.s),
      others.map((r) => Math.log(r.nominalDa))
    );
    const sPred = (Math.log(held.nominalDa) - fit.intercept) / fit.slope;
    return {
      order: held.order,
      label: held.label,
      sObserved: held.s ?? 0,
      sPredicted: sPred,
      residualPx: (held.s ?? 0) - sPred
    };
  });
}

export function calibrateLane(args: CalibrateArgs): CalibrationCore {
  const { laneId, ladderSpecId, rungs, observed, arcLength, params } = args;
  const alignment = alignLadder(rungs, observed, arcLength, params.ladder.gapPenalty);
  const diagnostics = alignment.diagnostics;
  const matched: (DetectedRungView & { s: number })[] = alignment.rungs
    .filter((r) => r.matched && r.s !== null)
    .map((r) => ({ ...r, s: r.s as number }));

  const segments: RulerSegment[] = [];
  for (let i = 1; i < matched.length; i++) {
    const lo = matched[i - 1];
    const hi = matched[i];
    const ordersBetween = alignment.rungs.filter(
      (r) => r.order > lo.order && r.order < hi.order && !r.matched
    );
    segments.push({
      sLow: lo.s,
      sHigh: hi.s,
      mwLowDa: lo.nominalDa,
      mwHighDa: hi.nominalDa,
      spansMissingRung: ordersBetween.length > 0
    });
  }

  const validRange =
    matched.length >= 2
      ? {
          sMin: matched[0].s - params.ruler.validMarginPx,
          sMax: matched[matched.length - 1].s + params.ruler.validMarginPx
        }
      : null;

  const globalFit =
    matched.length >= 2
      ? linearFit(
          matched.map((r) => r.s),
          matched.map((r) => Math.log(r.nominalDa))
        )
      : { slope: 0, intercept: 0, r2: 0 };

  return {
    kind: "calibration",
    laneId,
    ladderSpecId,
    valid: alignment.valid,
    rungs: alignment.rungs,
    segments,
    validRange,
    residuals: computeResiduals(matched),
    globalFit,
    diagnostics,
    candidateAlignments: alignment.candidateAlignments,
    paramsVersion: params.version
  };
}

export function outOfRangeDiagnostic(s: number, range: { sMin: number; sMax: number } | null, laneId: string): Diagnostic | null {
  if (!range || s < range.sMin || s > range.sMax) {
    return {
      code: "ruler-out-of-valid-range",
      message: "条带落在局部标尺有效区域之外，禁止外推；该分子量不可用",
      severity: "error",
      location: { kind: "pixel", id: laneId, pixel: { x: 0, y: s } }
    };
  }
  return null;
}
