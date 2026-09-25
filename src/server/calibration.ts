import type {
  BandMaterial,
  CalibrationSegment,
  ComputationRecord,
  Diagnostic,
  FrameRef,
  LaneCalibration,
  LadderFit,
  LadderSpecMaterial,
  LaneMaterial,
  Material,
  BandInference,
  Point
} from "../shared/domain.js";
import type { ParamPack } from "../shared/params.js";
import { RULE_PACK_VERSION } from "../shared/params.js";
import { contentId, digestOf } from "../shared/ids.js";
import { arcLocus, arcOfPoint, pointAtArc } from "../shared/geometry.js";
import { qtyFromValue, type Qty } from "../shared/quantities.js";
import { EVIDENCE_CODES } from "../shared/evidence.js";

interface LadderAssignment {
  ordinal: number;
  band: BandMaterial | null;
  nominalBase: number;
  arcS: number | null;
}

interface LadderMatch {
  assignments: LadderAssignment[];
}

function expectedArc(params: ParamPack, nominalBase: number): number {
  return params.migrationIntercept + (params.migrationLogBase - Math.log10(nominalBase)) * params.migrationSlope;
}

function matchLadderBands(
  lane: LaneMaterial,
  spec: LadderSpecMaterial,
  bands: BandMaterial[],
  params: ParamPack,
  diagnostics: Diagnostic[],
  frame: FrameRef
): LadderMatch {
  const locus = arcLocus(lane.polyline);
  const observed = bands
    .filter((b) => b.laneId === lane.id)
    .map((b) => ({ band: b, s: arcOfPoint(locus, b.center) }))
    .sort((a, b) => a.s - b.s);
  const wanted = spec.bands
    .filter((b) => b.present && b.nominal.status === "ok" && b.nominal.baseValue !== null && b.nominal.baseValue > 0)
    .sort((a, b) => (b.nominal.baseValue as number) - (a.nominal.baseValue as number));

  for (const entry of spec.bands) {
    if (entry.nominal.status !== "ok") {
      diagnostics.push({
        code: EVIDENCE_CODES.UNCONVERTABLE_VALUE_PRESERVED,
        severity: "warning",
        message: `ladder 第 ${entry.ordinal} 标称值「${entry.nominal.raw}」无法转换，保留原值在原位置，不参与拟合`,
        at: { frame, laneId: lane.id, field: `ladder.bands[${entry.ordinal - 1}].nominal` }
      });
    }
  }

  const n = observed.length;
  const m = wanted.length;
  const matched = new Map<number, number>();
  if (n > 0 && m > 0) {
    if (n === m) {
      for (let k = 0; k < n; k++) matched.set(k, k);
    } else if (n < m) {
      const gaps = observed.slice(1).map((o, k) => o.s - (observed[k]!.s));
      const medGap = gaps.length ? [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)]! : Infinity;
      const wantedSkips: number[] = [];
      for (let oi = 0; oi + 1 < n; oi++) {
        const gap = observed[oi + 1]!.s - observed[oi]!.s;
        const ratio = gap / medGap;
        if (ratio > 1.55) wantedSkips.push(Math.max(1, Math.round(ratio) - 1));
        else wantedSkips.push(0);
      }
      let wi = 0;
      for (let oi = 0; oi < n; oi++) {
        matched.set(wi, oi);
        const skip = oi < wantedSkips.length ? wantedSkips[oi]! : 0;
        wi += 1 + skip;
      }
      if (wi > m) matched.clear();
    } else {
      const wantedS = wanted.map((w) => expectedArc(params, w.nominal.baseValue as number));
      const used = new Set<number>();
      for (let oi = 0; oi < n; oi++) {
        let bestJ = -1;
        let bestD = Infinity;
        for (let wi2 = 0; wi2 < m; wi2++) {
          if (used.has(wi2)) continue;
          const d = Math.abs(observed[oi]!.s - wantedS[wi2]!);
          if (d < bestD) {
            bestD = d;
            bestJ = wi2;
          }
        }
        if (bestJ >= 0 && bestD <= params.migrationTolerancePx * 2) {
          matched.set(bestJ, oi);
          used.add(bestJ);
        }
      }
    }
  }

  const assignments: LadderAssignment[] = spec.bands
    .slice()
    .sort((a, b) => a.ordinal - b.ordinal)
    .map((entry) => {
      const wantedIdx = wanted.findIndex((w) => w.ordinal === entry.ordinal);
      const obsIdx = wantedIdx >= 0 ? matched.get(wantedIdx) : undefined;
      const obs = obsIdx !== undefined ? observed[obsIdx] : undefined;
      return {
        ordinal: entry.ordinal,
        band: obs?.band ?? null,
        nominalBase: entry.nominal.baseValue ?? Number.NaN,
        arcS: obs?.s ?? null
      };
    });

  for (const miss of assignments.filter((a) => a.band === null && Number.isFinite(a.nominalBase) && (spec.bands.find((b) => b.ordinal === a.ordinal)?.present ?? false))) {
    diagnostics.push({
      code: EVIDENCE_CODES.LADDER_MISSING_BAND_GAP,
      severity: "warning",
      message: `ladder 缺带：第 ${miss.ordinal} 标称带未检出，跨区间插值降级为候选并扩大不确定度`,
      at: { frame, laneId: lane.id }
    });
  }
  const matchedBandIds = new Set(assignments.filter((a) => a.band).map((a) => (a.band as BandMaterial).id));
  for (const extra of observed.filter((o) => !matchedBandIds.has(o.band.id))) {
    diagnostics.push({
      code: "GEL-LADDER-EXTRA-012",
      severity: "info",
      message: "ladder 泳道存在未匹配条带，作为候选保留，不参与标尺",
      at: { frame, x: extra.band.center.x, y: extra.band.center.y, bandId: extra.band.id }
    });
  }
  return { assignments };
}

function linearRegression(points: { x: number; y: number }[]): { slope: number; intercept: number; r2: number } | null {
  if (points.length < 2) return null;
  const n = points.length;
  const sx = points.reduce((a, p) => a + p.x, 0);
  const sy = points.reduce((a, p) => a + p.y, 0);
  const sxx = points.reduce((a, p) => a + p.x * p.x, 0);
  const sxy = points.reduce((a, p) => a + p.x * p.y, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return null;
  const slope = (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const mean = sy / n;
  const ssTot = points.reduce((a, p) => a + (p.y - mean) ** 2, 0);
  const ssRes = points.reduce((a, p) => a + (p.y - (slope * p.x + intercept)) ** 2, 0);
  return { slope, intercept, r2: ssTot === 0 ? 1 : 1 - ssRes / ssTot };
}

function buildSegments(
  fitId: string,
  laneId: string,
  assignments: LadderAssignment[],
  diagnostics: Diagnostic[],
  frame: FrameRef
): CalibrationSegment[] {
  const usable = assignments
    .filter((a) => a.band !== null && a.arcS !== null && Number.isFinite(a.nominalBase) && a.nominalBase > 0)
    .map((a) => ({ ordinal: a.ordinal, s: a.arcS as number, base: a.nominalBase, bandId: (a.band as BandMaterial).id }))
    .sort((a, b) => a.s - b.s);
  const segments: CalibrationSegment[] = [];
  for (let k = 0; k + 1 < usable.length; k++) {
    const lo = usable[k]!;
    const hi = usable[k + 1]!;
    const monotonic = hi.base < lo.base;
    const gapBridged = hi.ordinal - lo.ordinal > 1;
    const id = contentId("seg", { fitId, lo: lo.ordinal, hi: hi.ordinal });
    if (!monotonic) {
      diagnostics.push({
        code: EVIDENCE_CODES.NONMONOTONIC_RULER_SEGMENT,
        severity: "error",
        message: `非单调标尺段：弧长 ${lo.s.toFixed(1)}→${hi.s.toFixed(1)}px 上标称值未递减（${lo.base}→${hi.base}），该段不产生唯一分子量`,
        at: { frame, laneId, segmentId: id }
      });
    }
    if (gapBridged) {
      diagnostics.push({
        code: EVIDENCE_CODES.LADDER_MISSING_BAND_GAP,
        severity: "warning",
        message: `第 ${lo.ordinal}–${hi.ordinal} 标称带跨过缺带，插值仅作候选并扩大不确定度`,
        at: { frame, laneId, segmentId: id }
      });
    }
    segments.push({
      id,
      sLow: lo.s,
      sHigh: hi.s,
      logBaseLow: Math.log10(lo.base),
      logBaseHigh: Math.log10(hi.base),
      lowOrdinal: lo.ordinal,
      highOrdinal: hi.ordinal,
      valid: monotonic,
      monotonic,
      gapBridged,
      sourceLadderBandIds: [lo.bandId, hi.bandId]
    });
  }
  return segments;
}

function fitLadder(
  lane: LaneMaterial,
  spec: LadderSpecMaterial,
  bands: BandMaterial[],
  params: ParamPack,
  diagnostics: Diagnostic[],
  frame: FrameRef
): LadderFit {
  const fitDiags: Diagnostic[] = [];
  const match = matchLadderBands(lane, spec, bands, params, fitDiags, frame);
  const fitId = contentId("fit", {
    laneId: lane.id,
    specId: spec.id,
    paramsVersion: params.version,
    frame,
    assignments: match.assignments.map((a) => [a.ordinal, a.band?.id ?? null, a.arcS])
  });
  for (const a of match.assignments) {
    if (a.band && a.band.provenance.origin === "manual" && Number.isFinite(a.nominalBase)) {
      const drift = Math.abs((a.arcS as number) - expectedArc(params, a.nominalBase));
      if (drift >= 4.5) {
        fitDiags.push({
          code: EVIDENCE_CODES.REVISION_LOCAL_INVALIDATION,
          severity: "warning",
          message: `人工修订使第 ${a.ordinal} 档 ladder 条带中心偏离预期 ${drift.toFixed(1)}px：该 ladder 拟合与下游泳道校准身份更新，未依赖此来源的其他标尺保持不变`,
          at: { frame, laneId: lane.id, bandId: a.band.id }
        });
      }
    }
  }
  const segments = buildSegments(fitId, lane.id, match.assignments, fitDiags, frame);
  const usable = match.assignments
    .filter((a) => a.band !== null && a.arcS !== null && Number.isFinite(a.nominalBase) && a.nominalBase > 0)
    .map((a) => ({ ordinal: a.ordinal, s: a.arcS as number, base: a.nominalBase, bandId: (a.band as BandMaterial).id }))
    .sort((a, b) => a.s - b.s);
  const reg = linearRegression(usable.map((u) => ({ x: u.s, y: Math.log10(u.base) })));
  const residuals = usable.map((u) => {
    let fitted: number;
    if (params.model === "log-linear-global" && reg) {
      fitted = reg.slope * u.s + reg.intercept;
    } else {
      const seg = segments.find((sg) => sg.monotonic && u.s >= sg.sLow && u.s <= sg.sHigh && sg.sourceLadderBandIds.includes(u.bandId));
      fitted = seg ? seg.logBaseLow + ((u.s - seg.sLow) / (seg.sHigh - seg.sLow)) * (seg.logBaseHigh - seg.logBaseLow) : Math.log10(u.base);
    }
    const observed = Math.log10(u.base);
    return {
      ladderBandId: u.bandId,
      s: Math.round(u.s * 1000) / 1000,
      observedLogBase: Math.round(observed * 1e6) / 1e6,
      fittedLogBase: Math.round(fitted * 1e6) / 1e6,
      residual: Math.round((observed - fitted) * 1e6) / 1e6
    };
  });
  const validSegs = segments.filter((s) => s.valid);
  const validS: [number, number] | null = validSegs.length
    ? [Math.min(...validSegs.map((s) => s.sLow)), Math.max(...validSegs.map((s) => s.sHigh))]
    : null;
  diagnostics.push(...fitDiags);
  return {
    id: fitId,
    ladderLaneId: lane.id,
    model: params.model,
    globalSlope: reg ? Math.round(reg.slope * 1e8) / 1e8 : null,
    globalIntercept: reg ? Math.round(reg.intercept * 1e6) / 1e6 : null,
    rSquared: reg ? Math.round(reg.r2 * 1e6) / 1e6 : null,
    residuals,
    segments,
    validS,
    diagnostics: fitDiags
  };
}

function transferAnchor(ladderLane: LaneMaterial, sampleLane: LaneMaterial, ladderPoint: Point): number | null {
  const locus = arcLocus(ladderLane.polyline);
  const s = arcOfPoint(locus, ladderPoint);
  const p0 = pointAtArc(locus, Math.max(0, s - 2));
  const p1 = pointAtArc(locus, s + 2);
  const tx = p1.x - p0.x;
  const ty = p1.y - p0.y;
  const nx = -ty;
  const ny = tx;
  const sample = sampleLane.polyline;
  let bestS: number | null = null;
  let bestD = Number.POSITIVE_INFINITY;
  const sampleLocus = arcLocus(sample);
  for (let k = 0; k + 1 < sample.length; k++) {
    const a = sample[k]!;
    const b = sample[k + 1]!;
    const ex = b.x - a.x;
    const ey = b.y - a.y;
    const denom = nx * ey - ny * ex;
    if (Math.abs(denom) < 1e-9) continue;
    const dx = a.x - ladderPoint.x;
    const dy = a.y - ladderPoint.y;
    const t = (dx * ey - dy * ex) / denom;
    const u = (dx * ny - dy * nx) / denom;
    if (u < 0 || u > 1) continue;
    const ix = ladderPoint.x + t * nx;
    const iy = ladderPoint.y + t * ny;
    const d = Math.hypot(ix - ladderPoint.x, iy - ladderPoint.y);
    if (d < bestD) {
      bestD = d;
      bestS = (sampleLocus.cum[k] as number) + u * ((sampleLocus.cum[k + 1] as number) - (sampleLocus.cum[k] as number));
    }
  }
  return bestS;
}

function axisCoord(p: Point, frame: FrameRef): number {
  return frame === "rotated" ? p.x : p.y;
}

function interpolateSegment(seg: CalibrationSegment, s: number): number {
  const t = (s - seg.sLow) / (seg.sHigh - seg.sLow);
  return seg.logBaseLow + t * (seg.logBaseHigh - seg.logBaseLow);
}

function uncertaintyFor(seg: CalibrationSegment, centerUncertaintyPx: number, params: ParamPack): number {
  const slope = Math.abs((seg.logBaseHigh - seg.logBaseLow) / (seg.sHigh - seg.sLow));
  const base = slope * Math.max(centerUncertaintyPx, params.centerUncertaintyPx);
  return seg.gapBridged ? base * 2 : base;
}

function inferBand(
  band: BandMaterial,
  laneCal: LaneCalibration,
  lane: LaneMaterial,
  params: ParamPack,
  dimension: "mass-fragment" | "mass-protein",
  overlapMates: BandMaterial[],
  frame: FrameRef
): BandInference {
  const diagnostics: Diagnostic[] = [];
  const locus = arcLocus(lane.polyline);
  const s = arcOfPoint(locus, band.center);
  const baseUnit = dimension === "mass-fragment" ? "bp" : "kDa";
  const seg = laneCal.segments.find((x) => s >= x.sLow && s <= x.sHigh) ?? null;
  const outside = !laneCal.validS || s < laneCal.validS[0] || s > laneCal.validS[1];
  const id = contentId("bwinf", { band: band.id, cal: laneCal.id, params: params.version });

  if (outside || !seg) {
    diagnostics.push({
      code: EVIDENCE_CODES.OUT_OF_VALID_REGION,
      severity: "warning",
      message: "条带位于局部标尺有效弧长之外，未启用外推，不产生分子量",
      at: { frame, x: band.center.x, y: band.center.y, bandId: band.id, laneId: lane.id }
    });
    return {
      id, bandId: band.id, laneCalibrationId: laneCal.id, segmentId: seg?.id ?? null,
      sAlongLane: Math.round(s * 100) / 100, status: "out-of-range",
      estimate: null, interval: null, candidates: [], uncertaintyBase: null,
      diagnostics, evidenceCodes: [EVIDENCE_CODES.OUT_OF_VALID_REGION, EVIDENCE_CODES.LOCAL_RULER_VALID_REGION]
    };
  }

  const logVal = interpolateSegment(seg, s);
  const baseVal = 10 ** logVal;
  const uLog = uncertaintyFor(seg, band.centerUncertaintyPx, params);
  const estimate = qtyFromValue(Math.round(baseVal * 100) / 100, baseUnit);
  const interval: [Qty, Qty] = [
    qtyFromValue(Math.round(10 ** (logVal - uLog) * 100) / 100, baseUnit),
    qtyFromValue(Math.round(10 ** (logVal + uLog) * 100) / 100, baseUnit)
  ];
  const uncertaintyBase = Math.round(baseVal * (10 ** uLog - 1) * 100) / 100;

  if (!seg.monotonic) {
    const swapped: CalibrationSegment = { ...seg, logBaseLow: seg.logBaseHigh, logBaseHigh: seg.logBaseLow };
    const alt = 10 ** interpolateSegment(swapped, s);
    diagnostics.push({
      code: EVIDENCE_CODES.NONMONOTONIC_RULER_SEGMENT,
      severity: "error",
      message: "条带落在非单调标尺段：分子量不唯一，保留全部合法候选",
      at: { frame, x: band.center.x, y: band.center.y, bandId: band.id, segmentId: seg.id }
    });
    const candidates = [
      qtyFromValue(Math.round(baseVal * 100) / 100, baseUnit),
      qtyFromValue(Math.round(alt * 100) / 100, baseUnit)
    ].sort((a, b) => (a.baseValue ?? 0) - (b.baseValue ?? 0));
    return {
      id, bandId: band.id, laneCalibrationId: laneCal.id, segmentId: seg.id,
      sAlongLane: Math.round(s * 100) / 100, status: "indeterminate",
      estimate: null, interval: null, candidates, uncertaintyBase: null,
      diagnostics, evidenceCodes: [EVIDENCE_CODES.NONMONOTONIC_RULER_SEGMENT]
    };
  }

  const saturatedNow = band.saturated || band.peakIntensity >= params.saturationIntensity;
  if (saturatedNow) {
    diagnostics.push({
      code: EVIDENCE_CODES.SATURATED_BAND_CANDIDATE_OR_INTERVAL,
      severity: "warning",
      message: "饱和条带：峰顶被削平，中心位置不可靠，只能给区间",
      at: { frame, x: band.center.x, y: band.center.y, bandId: band.id }
    });
    return {
      id, bandId: band.id, laneCalibrationId: laneCal.id, segmentId: seg.id,
      sAlongLane: Math.round(s * 100) / 100, status: "interval",
      estimate, interval, candidates: [], uncertaintyBase,
      diagnostics, evidenceCodes: [EVIDENCE_CODES.SATURATED_BAND_CANDIDATE_OR_INTERVAL]
    };
  }

  if (band.overlapGroupId && overlapMates.length > 1) {
    const candidates = overlapMates
      .map((mate) => {
        const ms = arcOfPoint(locus, mate.center);
        const mseg = laneCal.segments.find((x) => ms >= x.sLow && ms <= x.sHigh);
        if (!mseg || !mseg.monotonic) return null;
        return qtyFromValue(Math.round(10 ** interpolateSegment(mseg, ms) * 100) / 100, baseUnit);
      })
      .filter((q): q is Qty => q !== null);
    diagnostics.push({
      code: EVIDENCE_CODES.OVERLAPPING_BANDS_CANDIDATES,
      severity: "warning",
      message: "重叠双峰未解卷积，保留组内全部候选值",
      at: { frame, x: band.center.x, y: band.center.y, bandId: band.id }
    });
    return {
      id, bandId: band.id, laneCalibrationId: laneCal.id, segmentId: seg.id,
      sAlongLane: Math.round(s * 100) / 100, status: "candidate",
      estimate: null, interval: null, candidates, uncertaintyBase: null,
      diagnostics, evidenceCodes: [EVIDENCE_CODES.OVERLAPPING_BANDS_CANDIDATES]
    };
  }

  if (band.provenance.origin === "manual" && band.peakIntensity < 80) {
    diagnostics.push({
      code: "GEL-MANUAL-013",
      severity: "info",
      message: "人工补录的弱带（低于自动检测阈值），分子量仅作候选",
      at: { frame, x: band.center.x, y: band.center.y, bandId: band.id }
    });
    return {
      id, bandId: band.id, laneCalibrationId: laneCal.id, segmentId: seg.id,
      sAlongLane: Math.round(s * 100) / 100, status: "candidate",
      estimate, interval: null, candidates: [estimate], uncertaintyBase,
      diagnostics, evidenceCodes: ["GEL-MANUAL-013"]
    };
  }

  if (band.tailing !== "none") {
    diagnostics.push({
      code: EVIDENCE_CODES.TAILING_BAND_CANDIDATE,
      severity: "warning",
      message: "拖尾条带：轮廓不对称，分子量仅作为候选",
      at: { frame, x: band.center.x, y: band.center.y, bandId: band.id }
    });
    return {
      id, bandId: band.id, laneCalibrationId: laneCal.id, segmentId: seg.id,
      sAlongLane: Math.round(s * 100) / 100, status: "candidate",
      estimate, interval: null, candidates: [estimate], uncertaintyBase,
      diagnostics, evidenceCodes: [EVIDENCE_CODES.TAILING_BAND_CANDIDATE]
    };
  }

  if (seg.gapBridged) {
    diagnostics.push({
      code: EVIDENCE_CODES.LADDER_MISSING_BAND_GAP,
      severity: "warning",
      message: "条带落在跨缺带区间，插值结果降级为候选",
      at: { frame, x: band.center.x, y: band.center.y, bandId: band.id, segmentId: seg.id }
    });
    return {
      id, bandId: band.id, laneCalibrationId: laneCal.id, segmentId: seg.id,
      sAlongLane: Math.round(s * 100) / 100, status: "candidate",
      estimate, interval: null, candidates: [estimate], uncertaintyBase,
      diagnostics, evidenceCodes: [EVIDENCE_CODES.LADDER_MISSING_BAND_GAP]
    };
  }

  return {
    id, bandId: band.id, laneCalibrationId: laneCal.id, segmentId: seg.id,
    sAlongLane: Math.round(s * 100) / 100, status: "accepted",
    estimate, interval: null, candidates: [], uncertaintyBase,
    diagnostics, evidenceCodes: []
  };
}

export interface ComputeInput {
  materials: Material[];
  params: ParamPack;
  frame: FrameRef;
  parentDependencyIds?: string[];
}

export function computeComputation(input: ComputeInput): ComputationRecord {
  const frame = input.frame;
  const params = input.params;
  const diagnostics: Diagnostic[] = [];
  const materials = input.materials;
  const lanes = materials
    .filter((m): m is LaneMaterial => m.kind === "lane" && m.frame === frame)
    .sort((a, b) => a.laneOrdinal - b.laneOrdinal || a.id.localeCompare(b.id));
  const bands = materials
    .filter((m): m is BandMaterial => m.kind === "band" && m.frame === frame)
    .sort((a, b) => a.laneId.localeCompare(b.laneId) || a.center.y - b.center.y || a.center.x - b.center.x || a.id.localeCompare(b.id));
  const specs = materials.filter((m): m is LadderSpecMaterial => m.kind === "ladder-spec");
  const images = materials.filter((m) => m.kind === "image" && m.frame === frame);

  if (frame === "rotated") {
    diagnostics.push({
      code: EVIDENCE_CODES.ROTATED_FRAME_PROVENANCE,
      severity: "info",
      message: "像素来源为旋转帧：泳道与条带坐标经旋转变换派生，原图与旋转图均保留",
      at: { frame }
    });
  }

  const fits: LadderFit[] = [];
  for (const lane of lanes.filter((l) => l.role === "ladder")) {
    const spec = lane.ladderSpecId ? specs.find((s) => s.id === lane.ladderSpecId) : undefined;
    if (!spec) {
      diagnostics.push({ code: "GEL-LADDER-NO-SPEC", severity: "error", message: `ladder 泳道 ${lane.laneOrdinal} 缺少标称规格`, at: { frame, laneId: lane.id } });
      continue;
    }
    fits.push(fitLadder(lane, spec, bands, params, diagnostics, frame));
  }
  for (const fit of fits) {
    if (fit.validS) {
      diagnostics.push({
        code: EVIDENCE_CODES.LOCAL_RULER_VALID_REGION,
        severity: "info",
        message: `局部标尺有效弧长 s∈[${fit.validS[0].toFixed(1)}, ${fit.validS[1].toFixed(1)}]px（沿泳道中心线）`,
        at: { frame, laneId: fit.ladderLaneId }
      });
    }
  }

  const laneCalibrations: LaneCalibration[] = [];
  const sampleLanes = lanes.filter((l) => l.role === "sample");
  for (const lane of sampleLanes) {
    const ladderLane = lanes
      .filter((l) => l.role === "ladder")
      .sort((a, b) => Math.abs((a.polyline[0]?.x ?? 0) - (lane.polyline[0]?.x ?? 0)) - Math.abs((b.polyline[0]?.x ?? 0) - (lane.polyline[0]?.x ?? 0)))[0];
    if (!ladderLane) continue;
    const fit = fits.find((f) => f.ladderLaneId === ladderLane.id);
    if (!fit) continue;
    const ladderBands = bands.filter((b) => b.laneId === ladderLane.id);
    const anchorS: number[] = [];
    const segments: CalibrationSegment[] = [];
    for (const seg of fit.segments) {
      const loBand = ladderBands.find((b) => b.id === seg.sourceLadderBandIds[0]);
      const hiBand = ladderBands.find((b) => b.id === seg.sourceLadderBandIds[1]);
      const sLow = loBand ? transferAnchor(ladderLane, lane, loBand.center) : null;
      const sHigh = hiBand ? transferAnchor(ladderLane, lane, hiBand.center) : null;
      if (sLow === null || sHigh === null) continue;
      anchorS.push(sLow, sHigh);
      segments.push({
        ...seg,
        id: contentId("seg", { cal: `${lane.id}:${fit.id}`, lo: seg.lowOrdinal, hi: seg.highOrdinal }),
        sLow,
        sHigh
      });
    }
    const validS: [number, number] | null = anchorS.length ? [Math.min(...anchorS), Math.max(...anchorS)] : null;
    laneCalibrations.push({
      id: contentId("lanecal", { lane: lane.id, fit: fit.id }),
      laneId: lane.id,
      fromLadderLaneId: ladderLane.id,
      ladderFitId: fit.id,
      segments,
      validS,
      anchorS: anchorS.map((s) => Math.round(s * 100) / 100)
    });
  }

  const ladderLanesForSmile = lanes.filter((l) => l.role === "ladder");
  if (fits.length >= 2 && ladderLanesForSmile.length >= 2) {
    const fitA = fits[0]!;
    const fitB = fits[1]!;
    const laneA = ladderLanesForSmile.find((l) => l.id === fitA.ladderLaneId)!;
    const laneB = ladderLanesForSmile.find((l) => l.id === fitB.ladderLaneId)!;
    const locusA = arcLocus(laneA.polyline);
    const locusB = arcLocus(laneB.polyline);
    if (fitA.validS && fitB.validS) {
      const low = Math.max(fitA.validS[0], fitB.validS[0]);
      const high = Math.min(fitA.validS[1], fitB.validS[1]);
      if (high > low) {
        const sA = (low + high) / 2;
        const pointA = pointAtArc(locusA, sA);
        const axis = axisCoord(pointA, frame);
        let bestB = locusB.points[0] as Point;
        let bestD = Number.POSITIVE_INFINITY;
        for (const p of locusB.points) {
          const d = Math.abs(axisCoord(p, frame) - axis);
          if (d < bestD) {
            bestD = d;
            bestB = p;
          }
        }
        const sB = arcOfPoint(locusB, bestB);
        const segA = fitA.segments.find((x) => sA >= x.sLow && sA <= x.sHigh && x.monotonic);
        const segB = fitB.segments.find((x) => sB >= x.sLow && sB <= x.sHigh && x.monotonic);
        if (segA && segB) {
          const logA = interpolateSegment(segA, sA);
          const logB = interpolateSegment(segB, sB);
          if (Math.abs(logA - logB) > 1e-4) {
            diagnostics.push({
              code: EVIDENCE_CODES.SMILE_SAME_HEIGHT_DIFFERENT_MW,
              severity: "warning",
              message: `“微笑”弯曲：同一画面高度（轴坐标 ${axis.toFixed(1)}px）处，ladder#${laneA.laneOrdinal} 弧长 ${sA.toFixed(1)}px→10^${logA.toFixed(3)}，ladder#${laneB.laneOrdinal} 弧长 ${sB.toFixed(1)}px→10^${logB.toFixed(3)}；同高度不等于同分子量，每条泳道必须使用各自的局部标尺与有效区域`,
              at: { frame, y: Math.round(axis), laneId: laneA.id }
            });
          }
        }
      }
    }
  }

  const bandInferences: BandInference[] = [];
  for (const laneCal of laneCalibrations) {
    const lane = sampleLanes.find((l) => l.id === laneCal.laneId);
    if (!lane) continue;
    const fit = fits.find((f) => f.id === laneCal.ladderFitId);
    const ladderLane = fit ? lanes.find((l) => l.id === fit.ladderLaneId) : undefined;
    const spec = ladderLane?.ladderSpecId ? specs.find((s) => s.id === ladderLane.ladderSpecId) : undefined;
    const dimension = spec?.dimension ?? "mass-fragment";
    const laneBands = bands.filter((bd) => bd.laneId === lane.id);
    for (const band of laneBands) {
      const mates = band.overlapGroupId ? laneBands.filter((x) => x.overlapGroupId === band.overlapGroupId) : [band];
      bandInferences.push(inferBand(band, laneCal, lane, params, dimension, mates, frame));
    }
  }
  for (const inf of bandInferences) diagnostics.push(...inf.diagnostics);

  const inputDigest = digestOf({
    materialIds: materials.map((m) => m.id).sort(),
    paramsVersion: params.version,
    frame,
    rulePack: RULE_PACK_VERSION,
    imageIds: images.map((i) => i.id).sort()
  });
  return {
    id: contentId("comp", { inputDigest }),
    inputDigest,
    paramsVersion: params.version,
    parentDependencyIds: input.parentDependencyIds ?? [],
    rulePackVersion: RULE_PACK_VERSION,
    fits,
    laneCalibrations,
    bandInferences,
    diagnostics
  };
}
