/**
 * 分子量校准：局部标尺（ladder 点之间的插值段）必须带有效区域。
 * “微笑”弯曲使同一高度不等于同一分子量 —— 标尺按泳道局部建立。
 */
import type { Diagnostic, FitSegment, MwEstimate, Outcome, Quantity } from "../shared/types";
import { newId } from "../shared/util";

export const RULE_VERSION = "gel-ruler/1.2.0";

export interface LadderPoint {
  materialId: string;
  mwBp: number;
  /** 沿泳道的迁移距离（px, derived 坐标）。 */
  s: number;
}

const bp = (value: number): Quantity => ({ value, unit: "bp" });
const px = (value: number): Quantity => ({ value, unit: "px" });

/**
 * 由 ladder 点构建局部标尺段。
 * - 非单调（log10(mw) 未随 s 严格下降）的段标记为 non-monotonic，不参与推断。
 * - 缺带（标称值无观测点）在调用方体现为点缺失，相邻段标记 missing-anchor。
 */
export function buildRuler(
  laneId: string,
  points: LadderPoint[],
  opts: { missingNominalBp?: number[] } = {},
): { segments: FitSegment[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const sorted = [...points].sort((a, b) => a.s - b.s || a.materialId.localeCompare(b.materialId));
  const segments: FitSegment[] = [];

  for (let i = 0; i < sorted.length - 1; i++) {
    const lo = sorted[i];
    const hi = sorted[i + 1];
    const segBase = {
      id: `seg:${laneId}:${lo.materialId}->${hi.materialId}`,
      laneId,
      lowerLadderMaterialId: lo.materialId,
      upperLadderMaterialId: hi.materialId,
      validity: {
        laneId,
        sMin: px(lo.s),
        sMax: px(hi.s),
        mwMin: bp(Math.min(lo.mwBp, hi.mwBp)),
        mwMax: bp(Math.max(lo.mwBp, hi.mwBp)),
      },
      residual: 0,
    };
    const gap = (opts.missingNominalBp ?? []).some(
      (mw) => mw < Math.max(lo.mwBp, hi.mwBp) && mw > Math.min(lo.mwBp, hi.mwBp),
    );
    if (!(lo.mwBp > hi.mwBp)) {
      // 非单调标尺：迁移更远反而分子量更大（或相等），物理上不成立。
      segments.push({
        ...segBase,
        slope: 0,
        intercept: 0,
        status: "non-monotonic",
        invalidReason: `ladder 标称值非单调：s=${lo.s.toFixed(1)}px 处 ${lo.mwBp}bp 不大于 s=${hi.s.toFixed(1)}px 处 ${hi.mwBp}bp`,
      });
      diagnostics.push({
        code: "RULER_NON_MONOTONIC",
        message: `泳道 ${laneId} 的 ladder 在 ${lo.mwBp}bp 与 ${hi.mwBp}bp 之间非单调`,
        location: { materialId: hi.materialId, field: "normalized.mwBp" },
        severity: "error",
      });
      continue;
    }
    const yLo = Math.log10(lo.mwBp);
    const yHi = Math.log10(hi.mwBp);
    const slope = (yHi - yLo) / (hi.s - lo.s);
    segments.push({
      ...segBase,
      slope,
      intercept: yLo - slope * lo.s,
      status: gap ? "missing-anchor" : "valid",
      invalidReason: gap ? "段内存在缺失的 ladder 标称值（缺带），插值跨越证据空洞" : undefined,
    });
    if (gap) {
      diagnostics.push({
        code: "LADDER_GAP",
        message: `泳道 ${laneId} 的 ladder 在 ${lo.mwBp}bp 与 ${hi.mwBp}bp 之间缺带`,
        location: { materialId: lo.materialId },
        severity: "warning",
      });
    }
  }
  return { segments, diagnostics };
}

export interface BandObservation {
  bandMaterialId: string;
  laneId: string;
  /** 条带中心迁移距离；饱和/拖尾时为区间中点。 */
  s: number | null;
  /** 位置区间（饱和、拖尾、重叠时给出）。 */
  sInterval?: { lo: number; hi: number };
  saturated?: boolean;
  trailing?: boolean;
  overlapped?: boolean;
}

export interface InferBudget {
  maxSegmentProbes: number;
}

/**
 * 为单个条带推断分子量。
 * 资源预算耗尽、格式损坏、语义无解是三种不同结果。
 */
export function inferBandMw(
  segments: FitSegment[],
  obs: BandObservation,
  budget: InferBudget,
): Outcome<MwEstimate> {
  const base: MwEstimate = {
    id: `est:${obs.bandMaterialId}`,
    bandMaterialId: obs.bandMaterialId,
    laneId: obs.laneId,
    mw: null,
    status: "auto-candidate",
    diagnostics: [],
  };

  if (obs.s === null && !obs.sInterval) {
    return {
      kind: "format-corrupt",
      diagnostics: [
        {
          code: "BAND_POSITION_MISSING",
          message: "条带中心缺少迁移距离且未给出区间，输入格式不完整",
          location: { materialId: obs.bandMaterialId, field: "normalized.s" },
          severity: "error",
        },
      ],
    };
  }

  const laneSegments = segments.filter((s) => s.laneId === obs.laneId);
  if (laneSegments.length === 0) {
    return {
      kind: "semantic-unsolvable",
      diagnostics: [
        {
          code: "NO_LANE_RULER",
          message: `泳道 ${obs.laneId} 没有任何标尺段，无法建立局部标尺`,
          location: { materialId: obs.bandMaterialId },
          severity: "error",
        },
      ],
    };
  }

  let probes = 0;
  const covering = (s: number): FitSegment[] => {
    const hits: FitSegment[] = [];
    for (const seg of laneSegments) {
      probes++;
      if (probes > budget.maxSegmentProbes) {
        return hits;
      }
      if (s >= seg.validity.sMin.value && s <= seg.validity.sMax.value) hits.push(seg);
    }
    return hits;
  };

  const probeS = obs.s ?? (obs.sInterval!.lo + obs.sInterval!.hi) / 2;
  const hits = covering(probeS);
  if (probes > budget.maxSegmentProbes) {
    return { kind: "budget-exhausted", spent: probes, budget: budget.maxSegmentProbes };
  }

  const usable = hits.filter((h) => h.status === "valid");
  const invalidHits = hits.filter((h) => h.status !== "valid");

  // 饱和 / 拖尾 / 重叠：只能标为候选或区间。
  if (obs.saturated || obs.trailing || obs.overlapped || obs.sInterval) {
    const interval = obs.sInterval ?? { lo: probeS - 1.5, hi: probeS + 1.5 };
    const loHits = covering(interval.lo).filter((h) => h.status === "valid");
    const hiHits = covering(interval.hi).filter((h) => h.status === "valid");
    if (probes > budget.maxSegmentProbes) {
      return { kind: "budget-exhausted", spent: probes, budget: budget.maxSegmentProbes };
    }
    if (loHits.length === 0 || hiHits.length === 0) {
      return {
        kind: "semantic-unsolvable",
        diagnostics: [
          {
            code: "INTERVAL_OUTSIDE_RULER",
            message: "条带位置区间超出局部标尺有效区域，无法给出任何合法候选",
            location: { materialId: obs.bandMaterialId },
            severity: "error",
          },
        ],
      };
    }
    const mwHi = Math.pow(10, loHits[0].intercept + loHits[0].slope * interval.lo);
    const mwLo = Math.pow(10, hiHits[0].intercept + hiHits[0].slope * interval.hi);
    const reason = obs.saturated ? "饱和条带" : obs.overlapped ? "重叠条带" : "拖尾条带";
    return {
      kind: "ok",
      value: {
        ...base,
        interval: { lo: bp(Math.min(mwLo, mwHi)), hi: bp(Math.max(mwLo, mwHi)) },
        viaSegmentId: loHits[0].id,
        status: "interval-only",
        diagnostics: [
          {
            code: "BAND_NOT_PUNCTUAL",
            message: `${reason}：只能给出分子量区间，不能给出唯一点估计`,
            location: { materialId: obs.bandMaterialId },
            severity: "warning",
          },
        ],
      },
    };
  }

  if (usable.length === 0) {
    const reasons = invalidHits.map((h) => h.invalidReason ?? h.status).join("；");
    return {
      kind: "semantic-unsolvable",
      diagnostics: [
        {
          code: "NO_VALID_SEGMENT",
          message: `迁移距离 ${probeS.toFixed(1)}px 不在任何有效标尺段内${reasons ? `：${reasons}` : ""}`,
          location: { materialId: obs.bandMaterialId },
          severity: "error",
        },
      ],
    };
  }

  // 无法唯一决定时保留全部合法候选。
  const candidates = usable.map((seg) => ({
    mw: bp(Math.pow(10, seg.intercept + seg.slope * probeS)),
    viaSegmentId: seg.id,
  }));
  const first = candidates[0];
  return {
    kind: "ok",
    value: {
      ...base,
      mw: candidates.length === 1 ? first.mw : null,
      candidates: candidates.length > 1 ? candidates : undefined,
      viaSegmentId: first.viaSegmentId,
      diagnostics:
        candidates.length > 1
          ? [
              {
                code: "AMBIGUOUS_SEGMENTS",
                message: `迁移距离同时落入 ${candidates.length} 个有效段，保留全部合法候选`,
                location: { materialId: obs.bandMaterialId },
                severity: "warning",
              },
            ]
          : [],
    },
  };
}

/** 拟合残差：每个 ladder 点相对其相邻段插值的 log10(bp) 偏差。 */
export function rulerResiduals(points: LadderPoint[], segments: FitSegment[]) {
  return points.map((p) => {
    const seg = segments.find(
      (s) =>
        s.status === "valid" &&
        p.s >= s.validity.sMin.value &&
        p.s <= s.validity.sMax.value &&
        (s.lowerLadderMaterialId === p.materialId || s.upperLadderMaterialId === p.materialId),
    );
    const predicted = seg ? seg.intercept + seg.slope * p.s : Math.log10(p.mwBp);
    return {
      materialId: p.materialId,
      s: p.s,
      mwBp: p.mwBp,
      residualLog10Bp: Math.log10(p.mwBp) - predicted,
    };
  });
}
