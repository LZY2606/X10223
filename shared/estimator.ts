// 分子量推断：唯一值 / 候选集合 / 区间 / 失效 四态。饱和、拖尾、重叠禁止伪装成精确值。
import { quantityFromBase } from "./units";
import type { MwOption, RulerSegment } from "./artifacts";
import type { CalibrationCore } from "./calibration";

export interface EstimateInput {
  s: number;
  widthS: number;
  issues: string[];
  /** 重叠伙伴（各自有弧长位置） */
  overlapPartners?: { bandId: string; s: number }[];
  /** 跨泳道转移时的来源说明 */
  transferredFromLaneId?: string;
}

export type EstimateCore = Pick<
  import("./artifacts").BandEstimate,
  "s" | "point" | "candidates" | "interval" | "status" | "issues" | "diagnostics" | "evidence"
>;

function segmentAt(s: number, segments: RulerSegment[]): RulerSegment | null {
  for (const seg of segments) {
    if (s >= seg.sLow && s <= seg.sHigh) return seg;
  }
  return null;
}

function logMwAt(s: number, seg: RulerSegment): number {
  const t = (s - seg.sLow) / (seg.sHigh - seg.sLow || 1);
  return Math.log(seg.mwLowDa) + t * (Math.log(seg.mwHighDa) - Math.log(seg.mwLowDa));
}

function optionFor(s: number, cal: CalibrationCore): MwOption | null {
  const seg = segmentAt(s, cal.segments);
  if (!seg) return null;
  const da = Math.exp(logMwAt(s, seg));
  const segIndex = cal.segments.indexOf(seg);
  return {
    nominal: quantityFromBase(da, "kDa", "molecularMass"),
    da,
    segmentIndex: segIndex,
    inValidRange: !!cal.validRange && s >= cal.validRange.sMin && s <= cal.validRange.sMax,
    method: seg.spansMissingRung ? "interval" : "localPiecewise"
  };
}

function rungOrdersForSegment(cal: CalibrationCore, segIndex: number): number[] {
  const seg = cal.segments[segIndex];
  if (!seg) return [];
  const lo = cal.rungs.find((r) => r.matched && r.s === seg.sLow)?.order;
  const hi = cal.rungs.find((r) => r.matched && r.s === seg.sHigh)?.order;
  return [lo, hi].filter((x): x is number => x !== undefined);
}

export function estimateMw(input: EstimateInput, cal: CalibrationCore): EstimateCore {
  const diagnostics: import("./types").Diagnostic[] = [];
  const issues = [...input.issues];
  if (!cal.valid || !cal.validRange) {
    return {
      s: input.s,
      candidates: [],
      status: "invalid",
      issues,
      diagnostics: cal.diagnostics,
      evidence: { rungOrders: [], s: input.s }
    };
  }
  if (input.s < cal.validRange.sMin || input.s > cal.validRange.sMax) {
    return {
      s: input.s,
      candidates: [],
      status: "invalid",
      issues: [...issues, "outOfRulerRange"],
      diagnostics: [
        {
          code: "ruler-out-of-valid-range",
          message: "条带位于 ladder 有效区域之外（不外推）",
          severity: "error",
          location: { kind: "pixel", id: cal.laneId, pixel: { x: 0, y: input.s } }
        }
      ],
      evidence: { rungOrders: [], s: input.s }
    };
  }

  // 配准歧义：每组合法候选配准各产出一个分子量候选
  if (cal.candidateAlignments && cal.candidateAlignments.length > 1) {
    const cands: MwOption[] = [];
    for (const alignment of cal.candidateAlignments) {
      const matched = alignment.rungs.filter((r) => r.matched && r.s !== null) as { s: number; nominalDa: number }[];
      for (let i = 1; i < matched.length; i++) {
        if (input.s >= matched[i - 1].s && input.s <= matched[i].s) {
          const t = (input.s - matched[i - 1].s) / (matched[i].s - matched[i - 1].s || 1);
          const da = Math.exp(
            Math.log(matched[i - 1].nominalDa) + t * (Math.log(matched[i].nominalDa) - Math.log(matched[i - 1].nominalDa))
          );
          cands.push({
            nominal: quantityFromBase(da, "kDa", "molecularMass"),
            da,
            segmentIndex: i - 1,
            inValidRange: true,
            method: "localPiecewise"
          });
          break;
        }
      }
    }
    const uniq = dedupeOptions(cands);
    return {
      s: input.s,
      candidates: uniq,
      point: uniq.length === 1 ? uniq[0] : undefined,
      status: "candidate",
      issues: [...issues, "alignmentAmbiguous"],
      diagnostics: cal.diagnostics.filter((d) => d.code === "ladder-alignment-ambiguous"),
      evidence: { rungOrders: [], segmentIndex: uniq[0]?.segmentIndex, s: input.s }
    };
  }

  const point = optionFor(input.s, cal);
  const seg = segmentAt(input.s, cal.segments);
  const segIndex = seg ? cal.segments.indexOf(seg) : undefined;
  const rungOrders = segIndex !== undefined ? rungOrdersForSegment(cal, segIndex) : [];

  if (!point || !seg) {
    return {
      s: input.s,
      candidates: [],
      status: "invalid",
      issues: [...issues, "outOfRulerRange"],
      diagnostics: [{ code: "no-interpolation-segment", message: "没有覆盖该位置的插值段", severity: "error" }],
      evidence: { rungOrders, s: input.s }
    };
  }

  const saturated = issues.includes("saturated");
  const tailing = issues.includes("tailing");
  const overlap = issues.includes("overlap");

  // 饱和：中心位置不可信，给出区间，不给唯一精确值
  if (saturated) {
    const delta = Math.max(input.widthS, 1.5);
    const lowS = Math.min(input.s + delta, cal.validRange.sMax);
    const highS = Math.max(input.s - delta, cal.validRange.sMin);
    const lowOpt = optionFor(lowS, cal);
    const highOpt = optionFor(highS, cal);
    if (lowOpt && highOpt) {
      return {
        s: input.s,
        point: undefined,
        candidates: [point],
        interval: { low: lowOpt, high: highOpt },
        status: "interval",
        issues: [...issues, "saturated"],
        diagnostics: [
          { code: "saturated-band-interval", message: "饱和条带中心被削顶，只能报告分子量区间", severity: "warning" }
        ],
        evidence: { rungOrders, segmentIndex: segIndex, s: input.s }
      };
    }
  }

  // 重叠：保留本带与伙伴的全部合法候选，禁止二选一伪装唯一
  if (overlap && input.overlapPartners?.length) {
    const cands: MwOption[] = [point];
    for (const partner of input.overlapPartners) {
      const opt = optionFor(partner.s, cal);
      if (opt) cands.push(opt);
    }
    const uniq = dedupeOptions(cands);
    return {
      s: input.s,
      point: undefined,
      candidates: uniq,
      status: "candidate",
      issues: [...issues, "overlap"],
      diagnostics: [
        { code: "overlap-candidates", message: "重叠双带无法唯一归属，保留全部合法候选", severity: "warning" }
      ],
      evidence: { rungOrders, segmentIndex: segIndex, s: input.s }
    };
  }

  // 跨缺带插值段：以端点分子量给出区间
  if (seg.spansMissingRung) {
    const lowOpt: MwOption = {
      nominal: quantityFromBase(seg.mwHighDa, "kDa", "molecularMass"),
      da: seg.mwHighDa,
      segmentIndex: segIndex!,
      inValidRange: true,
      method: "interval"
    };
    const highOpt: MwOption = {
      nominal: quantityFromBase(seg.mwLowDa, "kDa", "molecularMass"),
      da: seg.mwLowDa,
      segmentIndex: segIndex!,
      inValidRange: true,
      method: "interval"
    };
    return {
      s: input.s,
      point: undefined,
      candidates: [point],
      interval: { low: lowOpt, high: highOpt },
      status: "interval",
      issues: [...issues, "missingLadderRung"],
      diagnostics: [
        { code: "missing-rung-interval", message: "该插值段跨越缺失 ladder 档，只能给区间", severity: "warning" }
      ],
      evidence: { rungOrders, segmentIndex: segIndex, s: input.s }
    };
  }

  // 拖尾：标为候选，显示推断值但不升级为确定
  if (tailing) {
    return {
      s: input.s,
      point,
      candidates: [point],
      status: "candidate",
      issues: [...issues, "tailing"],
      diagnostics: [{ code: "tailing-candidate", message: "拖尾带中心不稳定，作为候选", severity: "warning" }],
      evidence: { rungOrders, segmentIndex: segIndex, s: input.s }
    };
  }

  return {
    s: input.s,
    point,
    candidates: [point],
    status: "unique",
    issues,
    diagnostics: [],
    evidence: { rungOrders, segmentIndex: segIndex, s: input.s }
  };
}

function dedupeOptions(options: MwOption[]): MwOption[] {
  const seen = new Set<number>();
  const out: MwOption[] = [];
  for (const o of options) {
    const key = Math.round(o.da * 100);
    if (!seen.has(key)) {
      seen.add(key);
      out.push(o);
    }
  }
  return out;
}

