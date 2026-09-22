import type {
  BandResult,
  CalibrationParams,
  CalibrationSegment,
  Diagnostic,
  Judgment,
  LaneBoundaryMaterial,
  LadderNominalMaterial,
  Q,
} from './types.js';
import { q } from './geometry.js';
import { stableId } from './hash.js';
import type { Peak } from './imageops.js';

export interface Knot {
  id: string;
  s: number;
  mwBp: number;
  nominalId: string;
  observed?: boolean;
}

export interface LadderAssignment {
  knots: Knot[];
  rank: number;
}

/** 枚举“缺带”下全部合法单调配准：detected 升序 s 对应 nominal 的递增子序列。 */
export function enumerateAssignments(
  laneId: string,
  detected: Peak[],
  nominal: { id: string; mwBp: number }[],
  maxAssignments: number,
): { assignments: LadderAssignment[]; budgetExceeded: boolean } {
  // nominal 按迁移从小到大（分子量从大到小）；s 递增 ↔ 下标递增
  const result: LadderAssignment[] = [];
  let budgetExceeded = false;
  const recurse = (d: number, start: number, chosen: Knot[]) => {
    if (result.length > maxAssignments) {
      budgetExceeded = true;
      return;
    }
    if (d === detected.length) {
      if (chosen.length > 0) {
        result.push({ knots: chosen, rank: result.length });
      }
      return;
    }
    recurse(d + 1, start, chosen); // 允许该检测峰为杂带
    for (let n = start; n < nominal.length; n++) {
      recurse(d + 1, n + 1, [
        ...chosen,
        {
          id: stableId('knot', [laneId, detected[d].s, nominal[n].id]),
          s: detected[d].s,
          mwBp: nominal[n].mwBp,
          nominalId: nominal[n].id,
          observed: true,
        },
      ]);
      if (budgetExceeded) return;
    }
  };
  recurse(0, 0, []);
  return { assignments: result.slice(0, maxAssignments), budgetExceeded };
}

function strictlyMonotone(knots: Knot[]): boolean {
  for (let i = 1; i < knots.length; i++) {
    if (knots[i].s <= knots[i - 1].s) return false;
    if (knots[i].mwBp >= knots[i - 1].mwBp) return false;
  }
  return true;
}

/** 非单调标尺：s 递增但 bp 未严格递减 → 语义无解。 */
export function rejectNonMonotonic(
  laneId: string,
  knots: Knot[],
  frame: string,
): { ok: boolean; diagnostic?: Diagnostic } {
  if (knots.length >= 2 && !strictlyMonotone(knots)) {
    const bad = knots.findIndex((k, i) => i > 0 && k.mwBp >= knots[i - 1].mwBp);
    return {
      ok: false,
      diagnostic: {
        code: 'RULER_NONMONOTONIC',
        severity: 'error',
        failureClass: 'SEMANTIC_NO_SOLUTION',
        message: '标尺非单调：迁移弧长增加但分子量未严格下降，拒绝该校准',
        position: {
          frame,
          laneId,
          bandId: knots[bad]?.id,
          point: { x: knots[bad]?.s ?? 0, y: knots[bad]?.mwBp ?? 0 },
        },
      },
    };
  }
  return { ok: true };
}

function logFit(knots: Knot[]) {
  const n = knots.length;
  const xs = knots.map((k) => k.s);
  const ys = knots.map((k) => Math.log(k.mwBp));
  const mx = xs.reduce((a, b) => a + b, 0) / n;
  const my = ys.reduce((a, b) => a + b, 0) / n;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < n; i++) {
    sxy += (xs[i] - mx) * (ys[i] - my);
    sxx += (xs[i] - mx) ** 2;
    syy += (ys[i] - my) ** 2;
  }
  const slope = sxx ? sxy / sxx : 0;
  const intercept = my - slope * mx;
  const r2 = sxx && syy ? (sxy * sxy) / (sxx * syy) : 0;
  const residuals = knots.map((k) => {
    const predictedS = (Math.log(k.mwBp) - intercept) / (slope || 1e-9);
    return { knotId: k.id, residualPx: k.s - predictedS };
  });
  return { intercept, slope, r2, residuals };
}

/** 局部标尺必须带有效区域：每个插值段仅在两端 knot 之间有效。 */
export function buildSegments(
  laneId: string,
  frame: string,
  knots: Knot[],
  marginPx: number,
): CalibrationSegment[] {
  const fit = knots.length >= 2 ? logFit(knots) : null;
  const segments: CalibrationSegment[] = [];
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i];
    const b = knots[i + 1];
    const slopeLogPerPx = (Math.log(b.mwBp) - Math.log(a.mwBp)) / Math.max(1e-9, b.s - a.s);
    const residuals = [a, b].map((k) => {
      const predictedS = fit
        ? (Math.log(k.mwBp) - fit.intercept) / (fit.slope || 1e-9)
        : k.s;
      return {
        knotId: k.id,
        observedS: q(k.s, 'px', frame),
        predictedS: q(predictedS, 'px', frame),
        residualPx: k.s - predictedS,
      };
    });
    segments.push({
      id: stableId('seg', [laneId, a.id, b.id]),
      fromKnot: a.id,
      toKnot: b.id,
      s0: q(a.s, 'px', frame),
      s1: q(b.s, 'px', frame),
      mw0: q(a.mwBp, 'bp', 'ladder nominal'),
      mw1: q(b.mwBp, 'bp', 'ladder nominal'),
      validDomain: {
        min: q(a.s - marginPx, 'px', frame),
        max: q(b.s + marginPx, 'px', frame),
      },
      valid: true,
      slopeLogPerPx,
      residuals,
    });
  }
  return segments;
}

export function segmentMwAt(segment: CalibrationSegment, s: number): number {
  const s0 = segment.s0.value;
  const s1 = segment.s1.value;
  const t = (s - s0) / Math.max(1e-9, s1 - s0);
  return Math.exp(
    Math.log(segment.mw0.value) + t * (Math.log(segment.mw1.value) - Math.log(segment.mw0.value)),
  );
}

export interface SampleInferenceInput {
  laneId: string;
  frame: string;
  lane: LaneBoundaryMaterial;
  peaks: Peak[];
  bandMaterials: { id: string; at: { x: number; y: number }; source: 'auto' | 'manual' }[];
  segments: CalibrationSegment[];
  knotCount: number;
  params: CalibrationParams;
  ladderLane?: LaneBoundaryMaterial;
}

/**
 * 样本条带分子量推断。
 * 饱和 → candidate；拖尾 → interval；重叠 → 保留全部合法候选集合；
 * 落在全部插值段有效域外 → invalid（修订后局部失效）。
 */
export function inferSampleBands(
  input: SampleInferenceInput,
  decisions: Map<string, BandResult['decision']>,
): { bands: BandResult[]; diagnostics: Diagnostic[]; judgments: Judgment[] } {
  const bands: BandResult[] = [];
  const diagnostics: Diagnostic[] = [];
  const judgments: Judgment[] = [];

  for (const material of input.bandMaterials) {
    const peak = nearestPeak(input.peaks, material.at);
    const s = peak?.s ?? material.at.y;
    const flags: string[] = [];
    const bandDiagnostics: Diagnostic[] = [];
    const containing = input.segments.filter(
      (seg) => s >= seg.validDomain.min.value && s <= seg.validDomain.max.value,
    );

    if (peak?.saturated) flags.push('saturated');
    if (peak?.smeared) flags.push('smear');
    if (peak?.overlap) flags.push('overlap');

    let status: BandResult['status'] = 'accepted';
    let mwCandidates: BandResult['mwCandidates'];
    let mwRange: BandResult['mwRange'];
    let mw: Q | undefined;
    let segmentId: string | undefined;

    if (containing.length === 0 || input.knotCount < 2) {
      status = 'invalid';
      bandDiagnostics.push({
        code: 'OUTSIDE_VALID_DOMAIN',
        severity: 'error',
        failureClass: 'SEMANTIC_NO_SOLUTION',
        message:
          input.knotCount < 2
            ? '可用 ladder knot 少于 2，无法建立局部标尺'
            : '条带落在所有插值段有效区域之外（局部标尺失效）',
        position: { frame: input.frame, laneId: input.laneId, bandId: material.id, point: material.at },
      });
    } else {
      const candidates = containing.map((seg) => ({
        mw: q(segmentMwAt(seg, s), 'bp', `segment=${seg.id}`),
        segmentId: seg.id,
      }));
      mwCandidates = candidates;
      if (flags.includes('overlap')) {
        status = 'candidate';
        judgments.push({
          id: stableId('jdg', ['overlap', input.laneId, material.id]),
          rule: 'overlap-must-be-candidate-set',
          outcome: 'hold',
          targets: [material.id],
          evidence: { partnerS: peak?.partner, candidates: candidates.map((c) => c.mw.value) },
          basis: [
            { materialId: material.id, version: 1, frame: input.frame, at: [material.at] },
          ],
        });
      } else if (flags.includes('saturated')) {
        status = 'candidate';
        judgments.push({
          id: stableId('jdg', ['saturated', input.laneId, material.id]),
          rule: 'saturated-must-be-candidate',
          outcome: 'hold',
          targets: [material.id],
          evidence: { saturatedFraction: peak?.saturated, candidates: candidates.map((c) => c.mw.value) },
          basis: [{ materialId: material.id, version: 1, frame: input.frame, at: [material.at] }],
        });
      } else if (flags.includes('smear')) {
        status = 'interval';
        const values = candidates.map((c) => c.mw.value);
        const spread = peak ? peak.halfWidth : 0;
        mwRange = {
          min: q(Math.min(...values) * (1 - spread / 500), 'bp', 'smear lower bound'),
          max: q(Math.max(...values) * (1 + spread / 500), 'bp', 'smear upper bound'),
        };
        judgments.push({
          id: stableId('jdg', ['smear', input.laneId, material.id]),
          rule: 'smear-must-be-interval',
          outcome: 'hold',
          targets: [material.id],
          evidence: { halfWidthPx: peak?.halfWidth, range: [mwRange.min.value, mwRange.max.value] },
          basis: [{ materialId: material.id, version: 1, frame: input.frame, at: [material.at] }],
        });
      } else {
        mw = candidates[0].mw;
        segmentId = candidates[0].segmentId;
        status = 'accepted';
      }
    }

    const band: BandResult = {
      id: material.id,
      laneId: input.laneId,
      center: material.at,
      arcS: q(s, 'px', input.frame),
      status,
      flags,
      diagnostics: bandDiagnostics,
    };
    if (mwCandidates) band.mwCandidates = mwCandidates;
    if (mwRange) band.mwRange = mwRange;
    if (mw) band.mw = mw;
    if (segmentId) band.segmentId = segmentId;

    const decision = decisions.get(material.id);
    if (decision) {
      band.decision = decision;
      if (decision.eventId) {
        if (decision.note === 'rejected') band.status = 'rejected';
      }
    }
    bands.push(band);
    diagnostics.push(...bandDiagnostics);
  }
  return { bands, diagnostics, judgments };
}

function nearestPeak(peaks: Peak[], at: { x: number; y: number }): Peak | undefined {
  let best: Peak | undefined;
  let bestD = Infinity;
  for (const peak of peaks) {
    const d = Math.abs(peak.s - at.y);
    if (d < bestD) {
      bestD = d;
      best = peak;
    }
  }
  return bestD < 40 ? best : undefined;
}
