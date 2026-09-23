import type {
  BandCenterObservation,
  CalibrationParamsV1,
  Diagnostic,
  LadderLinkObservation,
  LadderMaterial,
  LadderRulerPoint,
  MwEstimate,
  QNumber,
  RulerSegment,
  Unit,
} from '@shared/types.js';
import type { Image8 } from './image.js';
import { roundTo } from '@shared/util.js';

export interface LadderLaneInput {
  laneId: string;
  x: number; // 该泳道代表性 x（中心均值）
  links: { nominalId: string; bandObservationId: string; t: number }[];
}

export interface SampleBandInput {
  band: BandCenterObservation;
  t: number;
  laneX: number;
}

export interface CalibrationMathResult {
  curvatureK: number | null;
  curvatureReferenceX: number | null;
  curvatureSignificant: boolean;
  points: LadderRulerPoint[];
  segments: RulerSegment[];
  diagnostics: Diagnostic[];
  globalFit: {
    status: 'valid' | 'invalid';
    slope: number | null;
    intercept: number | null;
    rmsResidualLog: number | null;
    invalidReason?: string;
  };
}

const R = (x: number): number => roundTo(x, 8);

/** 从多条 ladder 泳道链接点估计微笑曲率：t = a + k*(x-xRef)^2。 */
export function estimateCurvature(
  ladder: LadderMaterial,
  lanes: LadderLaneInput[],
  curvatureSignificantPx: number,
): { k: number | null; xRef: number | null; significant: boolean; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const usable = lanes.filter((l) => l.links.length >= 3);
  if (usable.length < 2) {
    if (usable.length <= 1) {
      diagnostics.push({
        code: 'curvature-unresolved',
        severity: 'warning',
        message: '少于 2 条带足够链接点的 ladder 泳道，微笑曲率无法估计，只能使用严格局部标尺。',
        subjectIds: usable.map((u) => u.laneId),
      });
    }
    return { k: null, xRef: null, significant: false, diagnostics };
  }

  const ref = usable.reduce((a, b) => (a.x < b.x ? a : b));
  const xRef = ref.x;
  const others = usable.filter((l) => l.laneId !== ref.laneId);
  const ks: number[] = [];
  for (const nominal of ladder.bands) {
    const p0 = ref.links.find((l) => l.nominalId === nominal.nominalId);
    if (!p0) continue;
    for (const o of others) {
      const p1 = o.links.find((l) => l.nominalId === nominal.nominalId);
      if (!p1) continue;
      const dx2 = (o.x - xRef) ** 2;
      if (dx2 > 1) ks.push((p1.t - p0.t) / dx2);
    }
  }
  if (ks.length === 0) {
    diagnostics.push({
      code: 'curvature-unresolved',
      severity: 'warning',
      message: 'ladder 泳道间没有共同标称行，曲率无法估计。',
      subjectIds: lanes.map((l) => l.laneId),
    });
    return { k: null, xRef: null, significant: false, diagnostics };
  }
  const k = ks.reduce((a, b) => a + b, 0) / ks.length;
  // 曲率幅度：在最外侧泳道上的二次偏移量
  const maxDx2 = Math.max(...usable.map((l) => (l.x - xRef) ** 2));
  const amplitude = Math.abs(k) * maxDx2;
  const significant = amplitude > curvatureSignificantPx;
  if (significant) {
    diagnostics.push({
      code: 'smile-curvature-significant',
      severity: 'warning',
      message:
        '检测到“微笑”弯曲：同一像素高度不等于同一分子量，已启用带有效区域的局部标尺；全局统一标尺被禁用。',
      subjectIds: lanes.map((l) => l.laneId),
    });
  }
  return { k: R(k), xRef: R(xRef), significant, diagnostics };
}

/**
 * 局部标尺：先把各 ladder 泳道链接点校正到参考泳道的迁移坐标 t0=t-k(x-xRef)^2，
 * 再按标称池化。相邻标称之间形成插值段；有效区域 = 已覆盖 t 区间 × ladder 横向 x 区间。
 * 曲率无法判定时（仅 1 条 ladder），标尺只在该 ladder 泳道横向有效。
 */
export function buildSegments(
  ladder: LadderMaterial,
  lanes: LadderLaneInput[],
  k: number | null,
  xRef: number | null,
  minBands: number,
): { points: LadderRulerPoint[]; segments: RulerSegment[]; diagnostics: Diagnostic[]; validXRange: [number, number] | null } {
  const nominalById = new Map(ladder.bands.map((b) => [b.nominalId, b]));
  const diagnostics: Diagnostic[] = [];
  const points: LadderRulerPoint[] = [];
  const usable = lanes.filter((l) => l.links.length > 0);
  if (usable.length === 0) {
    return { points, segments: [], diagnostics, validXRange: null };
  }

  const xValues = usable.map((l) => l.x);
  const xMin = Math.min(...xValues);
  const xMax = Math.max(...xValues);
  const validXRange: [number, number] =
    k === null ? [R(xMin - 1), R(xMax + 1)] : [R(xMin), R(xMax)];

  for (const lane of usable) {
    for (const link of lane.links) {
      const nominal = nominalById.get(link.nominalId);
      if (!nominal) continue;
      const correctedT = k === null || xRef === null ? link.t : R(link.t - k * (lane.x - xRef) ** 2);
      points.push({
        nominalId: link.nominalId,
        bandObservationId: link.bandObservationId,
        laneId: lane.laneId,
        t: correctedT,
        logNominal: Math.log(nominal.nominal.value),
        x: lane.x,
      });
    }
  }

  // 按标称池化（取各 ladder 校正 t 的中位数，对个别误链稳健）
  const byNominal = new Map<string, LadderRulerPoint[]>();
  for (const p of points) {
    const arr = byNominal.get(p.nominalId) ?? [];
    arr.push(p);
    byNominal.set(p.nominalId, arr);
  }
  const ordered = ladder.bands
    .map((b) => {
      const arr = byNominal.get(b.nominalId);
      if (!arr || arr.length === 0) return null;
      const ts = arr.map((p) => p.t).sort((a, b2) => a - b2);
      return {
        nominalId: b.nominalId,
        logNominal: Math.log(b.nominal.value),
        t: ts[Math.floor(ts.length / 2)],
        contributors: arr,
      };
    })
    .filter((v): v is NonNullable<typeof v> => v !== null)
    .sort((a, b) => a.t - b.t);

  if (ordered.length < minBands) {
    diagnostics.push({
      code: 'ruler-insufficient-bands',
      severity: 'error',
      message: `可用 ladder 链接点 ${ordered.length} 个，少于 ${minBands}，无法建立标尺。`,
      subjectIds: lanes.map((l) => l.laneId),
    });
    return { points, segments: [], diagnostics, validXRange };
  }

  const segments: RulerSegment[] = [];
  for (let i = 0; i < ordered.length - 1; i++) {
    const a = ordered[i];
    const b = ordered[i + 1];
    const dt = b.t - a.t;
    const monotonic = dt > 0 && a.logNominal > b.logNominal;
    const slope = dt === 0 ? 0 : R((b.logNominal - a.logNominal) / dt);
    const intercept = R(a.logNominal - slope * a.t);
    if (!monotonic) {
      diagnostics.push({
        code: 'ruler-non-monotonic',
        severity: 'error',
        message: `局部标尺段 ${a.nominalId}→${b.nominalId} 非单调（迁移增大但标称未减小，或链接错位），该段插值与依赖它的分子量判为不可用。`,
        subjectIds: [...a.contributors.map((c) => c.bandObservationId), ...b.contributors.map((c) => c.bandObservationId)],
        segmentId: `seg:${a.nominalId}-${b.nominalId}`,
      });
    }
    segments.push({
      segmentId: `seg:${a.nominalId}-${b.nominalId}`,
      ladderLaneId: a.contributors[0].laneId,
      fromNominalId: a.nominalId,
      toNominalId: b.nominalId,
      fromT: a.t,
      toT: b.t,
      validTRange: [R(a.t), R(b.t)],
      validXRange,
      slope,
      intercept,
      monotonic,
      residualLog: 0,
    });
  }
  return { points, segments, diagnostics, validXRange };
}

/** 全局线性拟合（所有点），用于残差对比；弯曲显著时必须 invalid。 */
export function globalLinearFit(
  points: LadderRulerPoint[],
  curvatureSignificant: boolean,
): CalibrationMathResult['globalFit'] {
  const usable = points;
  if (usable.length < 2) {
    return { status: 'invalid', slope: null, intercept: null, rmsResidualLog: null, invalidReason: 'ladder 点不足' };
  }
  const n = usable.length;
  const meanT = usable.reduce((s, p) => s + p.t, 0) / n;
  const meanL = usable.reduce((s, p) => s + p.logNominal, 0) / n;
  let num = 0;
  let den = 0;
  for (const p of usable) {
    num += (p.t - meanT) * (p.logNominal - meanL);
    den += (p.t - meanT) ** 2;
  }
  if (den === 0) {
    return { status: 'invalid', slope: null, intercept: null, rmsResidualLog: null, invalidReason: '迁移距离无方差' };
  }
  const slope = R(num / den);
  const intercept = R(meanL - slope * meanT);
  const rms = R(
    Math.sqrt(usable.reduce((s, p) => s + (p.logNominal - (slope * p.t + intercept)) ** 2, 0) / n),
  );
  if (curvatureSignificant) {
    return {
      status: 'invalid',
      slope,
      intercept,
      rmsResidualLog: rms,
      invalidReason: '微笑弯曲显著：同一高度不对应同一分子量，全局统一标尺被禁止。',
    };
  }
  if (slope >= 0) {
    return { status: 'invalid', slope, intercept, rmsResidualLog: rms, invalidReason: '全局斜率非负，方向错误' };
  }
  return { status: 'valid', slope, intercept, rmsResidualLog: rms };
}

export interface MwInferenceInput {
  unit: Unit;
  k: number | null;
  xRef: number | null;
  curvatureSignificant: boolean;
  segments: RulerSegment[];
  validXRange: [number, number] | null;
  params: CalibrationParamsV1;
  sampleBands: SampleBandInput[];
}

function q(v: number, unit: Unit, raw?: string): QNumber {
  return { value: R(Math.exp(v)), unit, raw };
}

/** 在局部标尺段上做 log 线性插值，返回校正迁移 t0。 */
export function inferOne(
  band: SampleBandInput,
  input: MwInferenceInput,
): MwEstimate {
  const { k, xRef, segments, validXRange, params, unit } = input;
  const reasons: string[] = [];
  const correctedT = k === null || xRef === null ? R(band.t) : R(band.t - k * (band.laneX - xRef) ** 2);

  const ambiguous = band.band.flags.some((f) => f === 'saturated' || f === 'trailing' || f === 'overlap');
  for (const f of band.band.flags) {
    if (f === 'saturated') reasons.push('饱和条带：中心因平台失真，只给区间/候选');
    if (f === 'trailing') reasons.push('拖尾：中心不确定，只给区间/候选');
    if (f === 'overlap') reasons.push('两条带重叠：无法唯一决定，保留全部合法候选');
  }

  // 有效区域：横向必须被 ladder 覆盖；纵向落在最近段的允许外推范围内
  const xOk = validXRange ? band.laneX >= validXRange[0] && band.laneX <= validXRange[1] : false;
  if (!xOk) reasons.push('横向超出 ladder 有效区域，局部标尺不覆盖该泳道');

  const monotonicSegments = segments.filter((s) => s.monotonic);
  const containing = monotonicSegments.find((s) => correctedT >= s.validTRange[0] && correctedT <= s.validTRange[1]);

  let segment: RulerSegment | null = containing ?? null;
  if (!segment && monotonicSegments.length > 0 && params.extrapolateTolerance > 0) {
    const first = monotonicSegments[0];
    const last = monotonicSegments[monotonicSegments.length - 1];
    const span = last.validTRange[1] - first.validTRange[0];
    const below = first.validTRange[0] - correctedT;
    const above = correctedT - last.validTRange[1];
    if (below > 0 && below <= span * params.extrapolateTolerance) segment = first;
    else if (above > 0 && above <= span * params.extrapolateTolerance) segment = last;
    if (segment) reasons.push('处于 ladder 覆盖区间之外，按允许比例外推，证据较弱');
  }
  if (!segment && !reasons.some((r) => r.includes('横向'))) {
    reasons.push('纵向超出局部标尺有效区域且不允许外推');
  }

  const baseEstimate: MwEstimate = {
    bandObservationId: band.band.id,
    laneId: band.laneId,
    point: null,
    interval: null,
    candidates: [],
    status: 'unavailable',
    segmentId: segment?.segmentId ?? null,
    ladderLaneId: segment?.ladderLaneId ?? null,
    correctedT,
    withinValidRegion: xOk && containing !== null,
    uncertaintyReason: reasons,
  };

  if (!segment || !xOk) {
    return baseEstimate;
  }

  const logAt = (t: number): number => segment!.slope * t + segment!.intercept;

  // 重叠：保留全部合法候选（每候选中心点）
  if (band.band.flags.includes('overlap') && band.band.alternatives && band.band.alternatives.length > 0) {
    const candidates = band.band.alternatives.map((alt) => {
      const altT = k === null || xRef === null ? alt.y : alt.y - k * (band.laneX - xRef) ** 2;
      return q(logAt(altT), unit);
    });
    const logs = candidates.map((c) => Math.log(c.value)).sort((a, b2) => a - b2);
    return {
      ...baseEstimate,
      candidates,
      interval: { low: q(logs[0], unit), high: q(logs[logs.length - 1], unit) },
      status: 'candidate',
    };
  }

  if (ambiguous) {
    // 饱和/拖尾：以半宽或平台给区间（沿迁移 ±不确定像素）
    const half = band.band.flags.includes('saturated')
      ? Math.max(3, band.band.bbox.bottom - band.band.bbox.top) / 2
      : Math.max(2, band.band.bbox.bottom - band.band.bbox.top) / 3;
    const lowLog = logAt(correctedT + half);
    const highLog = logAt(correctedT - half);
    const lo = Math.min(lowLog, highLog);
    const hi = Math.max(lowLog, highLog);
    return {
      ...baseEstimate,
      interval: { low: q(lo, unit), high: q(hi, unit) },
      status: 'interval',
    };
  }

  const point = q(logAt(correctedT), unit);
  return { ...baseEstimate, point, status: 'valid' };
}

export function inferAll(input: MwInferenceInput): MwEstimate[] {
  return input.sampleBands.map((b) => inferOne(b, input));
}

/** 组装完整校准数学结果。 */
export function buildCalibrationMath(
  ladder: LadderMaterial,
  lanes: LadderLaneInput[],
  params: CalibrationParamsV1,
): Omit<CalibrationMathResult, 'diagnostics'> & { diagnostics: Diagnostic[] } {
  const curvature = estimateCurvature(lanes.length ? { ...ladder } : ladder, lanes, params.curvatureSignificantPx);
  const seg = buildSegments(ladder, lanes, curvature.k, curvature.xRef, params.minBandsForRuler);
  const globalFit = globalLinearFit(seg.points, curvature.significant);
  // 每段残差：相对全局线性模型在段中点的偏离（log 域）
  for (const s of seg.segments) {
    if (globalFit.slope !== null && globalFit.intercept !== null) {
      const mid = (s.fromT + s.toT) / 2;
      const segLog = s.slope * mid + s.intercept;
      const globalLog = globalFit.slope * mid + globalFit.intercept;
      s.residualLog = R(Math.abs(segLog - globalLog));
    }
  }
  const diagnostics = [...curvature.diagnostics, ...seg.diagnostics];
  if (globalFit.status === 'invalid' && curvature.significant) {
    diagnostics.push({
      code: 'global-ruler-rejected-smile',
      severity: 'warning',
      message: globalFit.invalidReason ?? '全局标尺被拒。',
      subjectIds: lanes.map((l) => l.laneId),
    });
  }
  void globalLinearFit;
  return {
    curvatureK: curvature.k,
    curvatureReferenceX: curvature.xRef,
    curvatureSignificant: curvature.significant,
    points: seg.points,
    segments: seg.segments,
    diagnostics,
    globalFit,
  };
}

export type { Image8 };
