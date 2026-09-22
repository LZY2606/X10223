import {
  RULES_VERSION,
  type BandVersion,
  type CalibrationCandidate,
  type CalibrationSegment,
  type Diagnostic,
  type DerivationInfo,
  type Judgment,
  type LadderKnot,
  type LadderNominalBand,
  type LadderSpec,
  type LaneVersion,
  type MwEstimate,
  type PixelPos,
} from '../shared/types';
import { contentHash, round4 } from '../shared/hash';
import { cumulativeArcLength, pointAtS, projectToSpine } from '../shared/geometry';

const J = (
  code: Judgment['code'],
  subjectId: string,
  message: string,
  data: Judgment['data'] = {},
): Judgment => ({ code, rule: RULES_VERSION, subjectId, message, data });

const diag = (
  code: string,
  message: string,
  severity: Diagnostic['severity'] = 'error',
  at?: Diagnostic['at'],
  outcome?: Diagnostic['outcome'],
): Diagnostic => ({ code, message, severity, at, outcome });

export function derivation(
  parents: string[],
  inputSummary: string[],
  paramVersion: string,
): DerivationInfo {
  return { parents, inputSummary, paramVersion, rulesVersion: RULES_VERSION };
}

// ---------------------------------------------------------------------------
// 标称值规范化：保留原始表示；无法转换留在原位置并附诊断，绝不为画图丢值
// ---------------------------------------------------------------------------

export function normalizeNominal(raw: string, ordinal: number, unitHint: string): LadderNominalBand {
  const text = raw.trim();
  const m = text.match(/^([0-9]*\.?[0-9]+)\s*(kbp|kb|bp|kda|k|)$/i);
  const lower = text.toLowerCase();
  let unit: 'bp' | 'kDa' | null = null;
  if (unitHint === 'bp') unit = 'bp';
  else if (unitHint === 'kDa') unit = 'kDa';
  let factor = 1;
  if (/kbp|kb/.test(lower)) {
    unit = 'bp';
    factor = 1000;
  } else if (/kda/.test(lower)) {
    unit = 'kDa';
    factor = 1;
  } else if (lower.endsWith('k')) {
    unit = unitHint === 'kDa' ? 'kDa' : 'bp';
    factor = unit === 'kDa' ? 1 : 1000;
  } else if (lower.endsWith('bp')) unit = 'bp';
  if (!m) {
    return {
      ordinal,
      raw: text,
      normalized: null,
      diagnostic: diag(
        'LADDER_VALUE_UNPARSEABLE',
        `标称值无法转换：${JSON.stringify(text)}，保留原位置`,
        'error',
        { kind: 'ladder-band', id: `ordinal-${ordinal}`, ordinal },
      ),
    };
  }
  const value = Number(m[1]) * factor;
  return { ordinal, raw: text, normalized: { value, unit: unit ?? 'bp' } };
}

// ---------------------------------------------------------------------------
// rf 基准：上样端（脊柱顶部 s=0）到染料前沿（脊柱全长）
// ---------------------------------------------------------------------------

export interface ArcContext {
  originSPx: number;
  frontSPx: number;
  totalSPx: number;
}

export function rfFromS(s: number, ctx: ArcContext): number {
  const span = ctx.frontSPx - ctx.originSPx || 1;
  return round4(Math.max(0, Math.min(1, (s - ctx.originSPx) / span)));
}

/** 微笑弯曲核心：每个样品沿“自己的泳道曲线”取弧长，再归一到同一 rf */
export function bandArc(band: BandVersion, lane: LaneVersion): { s: number; rfPoint: PixelPos } {
  const { s } = projectToSpine(band.center, lane.spine);
  return { s, rfPoint: pointAtS(lane.spine, s) };
}

function laneArcBounds(lane: LaneVersion): ArcContext {
  const total = cumulativeArcLength(lane.spine).slice(-1)[0] ?? 0;
  return { originSPx: 0, frontSPx: total, totalSPx: total };
}

// ---------------------------------------------------------------------------
// 校准候选构建（含非单调判定、局部有效区间、拟合残差）
// ---------------------------------------------------------------------------

interface AssignedLadderBand {
  bandId: string;
  ordinal: number;
  mw: number;
  sPx: number;
  point: PixelPos;
}

export interface BuiltCalibration {
  candidate: CalibrationCandidate | null;
  diagnostics: Diagnostic[];
  nonMonotonic: boolean;
}

export function buildCalibrationCandidate(
  laneId: string,
  ladder: LadderSpec,
  assigned: AssignedLadderBand[],
  ctx: ArcContext,
  status: CalibrationCandidate['status'],
  parents: string[],
  inputSummary: string[],
  paramVersion: string,
): BuiltCalibration {
  const diagnostics: Diagnostic[] = [];
  const judgments: Judgment[] = [];

  if (assigned.length < 2) {
    diagnostics.push(
      diag(
        'CALIBRATION_TOO_FEW_KNOTS',
        '可用于插值的 ladder knot 少于 2 个，标尺语义无解',
        'error',
        { kind: 'lane', id: laneId },
        'SEMANTIC_UNRESOLVABLE',
      ),
    );
    return { candidate: null, diagnostics, nonMonotonic: false };
  }

  const ordered = [...assigned].sort((a, b) => a.sPx - b.sPx);

  // 非单调：沿迁移方向分子量必须单调下降（rf 增大 -> mw 减小）
  let nonMonotonic = false;
  for (let i = 1; i < ordered.length; i++) {
    if (ordered[i].mw >= ordered[i - 1].mw) {
      nonMonotonic = true;
      diagnostics.push(
        diag(
          'NONMONOTONIC_SCALE',
          `非单调标尺：rf 增大时分子量未下降（#${ordered[i - 1].ordinal}=${ordered[i - 1].mw} -> #${ordered[i].ordinal}=${ordered[i].mw}），该局部标尺失效`,
          'error',
          { kind: 'ladder-band', id: ordered[i].bandId, ordinal: ordered[i].ordinal, position: ordered[i].point },
          'SEMANTIC_UNRESOLVABLE',
        ),
      );
    }
  }
  if (nonMonotonic) {
    judgments.push(
      J('NONMONOTONIC_SCALE_UNRESOLVABLE', laneId, '非单调标尺使标定语义无解，禁止强行拟合', {
        knotCount: ordered.length,
      }),
    );
  }

  const unit = ladder.unit === 'kDa' ? 'kDa' : 'bp';
  const knots: LadderKnot[] = ordered.map((b) => ({
    id: contentHash('knot', [laneId, b.bandId, b.ordinal, b.mw, round4(b.sPx)]),
    bandId: b.bandId,
    ordinal: b.ordinal,
    mw: b.mw,
    unit,
    sPx: round4(b.sPx),
    rf: rfFromS(b.sPx, ctx),
    point: { x: round4(b.point.x), y: round4(b.point.y) },
    residualLog10: null,
  }));

  // log10(mw) 对 rf 的整体最小二乘（仅用于暴露残差，推断仍用分段插值）
  const n = knots.length;
  const meanRf = knots.reduce((a, k) => a + k.rf, 0) / n;
  const meanLg = knots.reduce((a, k) => a + Math.log10(k.mw), 0) / n;
  let num = 0;
  let den = 0;
  for (const k of knots) {
    num += (k.rf - meanRf) * (Math.log10(k.mw) - meanLg);
    den += (k.rf - meanRf) ** 2;
  }
  const globalSlope = den === 0 ? 0 : num / den;
  const intercept = meanLg - globalSlope * meanRf;
  let sq = 0;
  for (const k of knots) {
    const pred = globalSlope * k.rf + intercept;
    k.residualLog10 = round4(Math.log10(k.mw) - pred);
    sq += k.residualLog10 ** 2;
  }
  const rms = round4(Math.sqrt(sq / n));

  const segments: CalibrationSegment[] = [];
  for (let i = 0; i < knots.length - 1; i++) {
    const a = knots[i];
    const b = knots[i + 1];
    const segNonMono = b.mw >= a.mw;
    const slope = (b.rf - a.rf) === 0 ? 0 : (Math.log10(b.mw) - Math.log10(a.mw)) / (b.rf - a.rf);
    if (segNonMono) {
      judgments.push(
        J('NONMONOTONIC_SCALE_UNRESOLVABLE', a.bandId, '该插值段两端非单调，标为失效段', {
          rfMin: a.rf,
          rfMax: b.rf,
        }),
      );
    }
    segments.push({
      id: contentHash('seg', [a.id, b.id]),
      knotAId: a.id,
      knotBId: b.id,
      rfMin: a.rf,
      rfMax: b.rf,
      slope: round4(slope),
      valid: !segNonMono,
    });
  }

  judgments.unshift(
    J('SMILE_ARC_LENGTH_LOCAL_SCALE', laneId, '同一像素高度不等于同一分子量；沿各泳道弧长取 rf，插值段携带 rf 有效区域', {
      knotCount: knots.length,
      segmentCount: segments.length,
      arcTotalPx: round4(ctx.totalSPx),
    }),
  );

  const id = contentHash('cal', [
    laneId,
    knots.map((k) => [k.bandId, k.ordinal, k.mw, k.rf]),
    segments.map((s) => [s.rfMin, s.rfMax, s.valid]),
  ]);
  return {
    candidate: {
      id,
      assignment: Object.fromEntries(ordered.map((b) => [b.bandId, b.ordinal])),
      status,
      knots,
      segments,
      rmsResidualLog10: rms,
      valid: !nonMonotonic,
      diagnostics,
      judgments,
    },
    diagnostics,
    nonMonotonic,
  };
}

export type { AssignedLadderBand };

// ---------------------------------------------------------------------------
// 缺带：保留全部合法 ordinal 指派（不猜测）。对 ladder 泳道上检测到的条带与
// 标称序列做“保持顺序的子序列匹配”，每一种指派都是一个候选校准。
// ---------------------------------------------------------------------------

export function enumerateLadderAssignments(
  ladderBandsByS: BandVersion[],
  ladder: LadderSpec,
): Array<Record<string, number>> {
  const usable = ladder.bands.filter((b) => b.normalized);
  const det = ladderBandsByS.filter((b) => b.valid);
  const nom = usable;
  const results: Array<Record<string, number>> = [];
  if (det.length === 0 || nom.length < det.length) return results;

  const recurse = (di: number, ni: number, map: Record<string, number>) => {
    if (di === det.length) {
      results.push({ ...map });
      return;
    }
    for (let i = ni; i < nom.length; i++) {
      const left = det.length - di - 1;
      if (nom.length - i - 1 < left) break;
      map[det[di].bandId] = nom[i].ordinal;
      recurse(di + 1, i + 1, map);
      delete map[det[di].bandId];
    }
  };
  recurse(0, 0, {});
  return results;
}

// ---------------------------------------------------------------------------
// 样品条带分子量推断
//  - 正常 + 落在有效段内 => point
//  - 饱和 => candidate（全部合法值 + 位置候选）
//  - 拖尾 / 重叠 => interval（无法唯一点估计）
//  - 越界 => 开区间
//  - 非单调 / 无候选 => SEMANTIC_UNRESOLVABLE 诊断
// ---------------------------------------------------------------------------

function interpolateLog(cal: CalibrationCandidate, rf: number) {
  for (const seg of cal.segments) {
    if (seg.valid && rf >= seg.rfMin && rf <= seg.rfMax) {
      const a = cal.knots.find((k) => k.id === seg.knotAId);
      const b = cal.knots.find((k) => k.id === seg.knotBId);
      if (!a || !b) continue;
      const t = (rf - seg.rfMin) / (seg.rfMax - seg.rfMin || 1);
      const lg = Math.log10(a.mw) + t * (Math.log10(b.mw) - Math.log10(a.mw));
      return { value: round4(10 ** lg), segmentId: seg.id, a, b };
    }
  }
  return null;
}

export interface EstimateInput {
  band: BandVersion;
  lane: LaneVersion;
  cal: CalibrationCandidate | null;
  paramVersion: string;
  parents: string[];
  inputSummary: string[];
}

export function estimateBand(input: EstimateInput): MwEstimate {
  const { band, lane, cal, paramVersion, parents, inputSummary } = input;
  const ev = band.evidence;
  const bounds = laneArcBounds(lane);
  const { s } = bandArc(band, lane);
  const rf = rfFromS(s, bounds);
  const unit: 'bp' | 'kDa' = 'bp';
  const judgments: Judgment[] = [];
  const reasonCodes: string[] = [];
  const diagnostics: Diagnostic[] = [];

  const base: MwEstimate = {
    id: contentHash('est', [band.bandId, cal?.id ?? null, round4(rf), ev.saturated, ev.smear, ev.overlap]),
    bandId: band.bandId,
    laneId: lane.laneId,
    kind: 'point',
    value: null,
    interval: null,
    alternatives: [],
    unit: cal ? cal.knots[0]?.unit ?? unit : unit,
    rf,
    sPx: round4(s),
    segmentId: null,
    valid: false,
    reasonCodes,
    judgments,
    derivation: derivation(parents, inputSummary, paramVersion),
  };

  if (!cal || !cal.valid || cal.knots.length < 2) {
    reasonCodes.push('NO_USABLE_CALIBRATION');
    diagnostics.push(
      diag('NO_USABLE_CALIBRATION', '无有效校准（非单调或缺 knot），分子量不可推断', 'error', {
        kind: 'band',
        id: band.bandId,
        position: band.center,
      }, 'SEMANTIC_UNRESOLVABLE'),
    );
    base.judgments.push(
      J('NONMONOTONIC_SCALE_UNRESOLVABLE', band.bandId, '标尺不可用，条带分子量无法唯一决定', {}),
    );
    base.judgments = [...base.judgments];
    return attachDiag(base, diagnostics);
  }

  const interp = interpolateLog(cal, rf);
  const rfMin = cal.segments.filter((x) => x.valid).reduce((m, x) => Math.min(m, x.rfMin), 1);
  const rfMax = cal.segments.filter((x) => x.valid).reduce((m, x) => Math.max(m, x.rfMax), 0);
  const topMw = cal.knots.slice().sort((a, b) => b.mw - a.mw)[0];
  const botMw = cal.knots.slice().sort((a, b) => a.mw - b.mw)[0];

  // 饱和：平台化峰值，真实中心不可信 -> candidate，保留由区域上下沿得到的全部合法值
  if (ev.saturated) {
    base.kind = 'candidate';
    reasonCodes.push('SATURATION');
    judgments.push(
      J('SATURATION_ONLY_CANDIDATE', band.bandId, '饱和条带峰值平台化，只能给候选，不给唯一点值', {
        saturatedFraction: round4(ev.saturatedFraction),
      }),
    );
    const span = bounds.totalSPx * 0.012;
    const hi = interpolateLog(cal, rfFromS(Math.max(0, s - span), bounds));
    const lo = interpolateLog(cal, rfFromS(Math.min(bounds.totalSPx, s + span), bounds));
    if (hi) base.alternatives.push(hi.value);
    if (interp) {
      base.alternatives.push(interp.value);
      base.segmentId = interp.segmentId;
    }
    if (lo) base.alternatives.push(lo.value);
    base.alternatives = Array.from(new Set(base.alternatives)).sort((a, b) => b - a);
    base.valid = base.alternatives.length > 0;
    if (!base.valid) {
      diagnostics.push(diag('SATURATION_NO_CANDIDATE', '饱和且无可用候选段', 'warning', { kind: 'band', id: band.bandId, position: band.center }));
    }
    return attachDiag(base, diagnostics);
  }

  // 拖尾：中心可定位但弥散宽 -> interval
  if (ev.smear) {
    base.kind = 'interval';
    reasonCodes.push('SMEAR');
    judgments.push(
      J('SMEAR_ONLY_INTERVAL', band.bandId, '拖尾条带弥散，只能给分子量区间', { regionPixels: ev.regionPixels }),
    );
  }

  // 重叠：两条带未分辨 -> interval，并保留各自候选
  if (ev.overlap) {
    base.kind = 'interval';
    reasonCodes.push('OVERLAP');
    judgments.push(
      J('OVERLAP_ONLY_INTERVAL', band.bandId, '两条带重叠未分辨，只能标为区间并保留候选', {}),
    );
  }

  if (interp) {
    base.segmentId = interp.segmentId;
    if (base.kind === 'point') {
      base.value = interp.value;
      base.valid = true;
    } else {
      // 区间：用区域沿弧长的半宽转换
      const half = ev.smear ? bounds.totalSPx * 0.02 : bounds.totalSPx * 0.012;
      const hiI = interpolateLog(cal, rfFromS(Math.max(0, s - half), bounds));
      const loI = interpolateLog(cal, rfFromS(Math.min(bounds.totalSPx, s + half), bounds));
      const low = loI?.value ?? interp.value;
      const high = hiI?.value ?? interp.value;
      base.interval = { low: round4(Math.min(low, high)), high: round4(Math.max(low, high)), openLow: false, openHigh: false };
      base.alternatives = Array.from(new Set([interp.value, hiI?.value, loI?.value].filter((v): v is number => typeof v === 'number'))).sort((a, b) => b - a);
      base.valid = true;
    }
  } else if (rf < rfMin || rf > rfMax) {
    // 越界：开区间，不给点值
    reasonCodes.push('OUT_OF_RANGE');
    judgments.push(
      J('OUT_OF_RANGE_OPEN_INTERVAL', band.bandId, '条带落在标尺有效区域之外，只给开区间', {
        rf,
        rfMin,
        rfMax,
      }),
    );
    if (rf < rfMin) {
      base.kind = 'interval';
      base.interval = { low: topMw.mw, high: Infinity, openLow: false, openHigh: true };
      base.alternatives = [];
      base.valid = true;
    } else {
      base.kind = 'interval';
      base.interval = { low: 0, high: botMw.mw, openLow: true, openHigh: false };
      base.alternatives = [];
      base.valid = true;
    }
  } else {
    diagnostics.push(
      diag('NO_SEGMENT', '不存在覆盖该 rf 的有效插值段（可能落在失效段）', 'error', {
        kind: 'band',
        id: band.bandId,
        position: band.center,
      }, 'SEMANTIC_UNRESOLVABLE'),
    );
    judgments.push(
      J('LOCAL_INVALIDATION_AFTER_REVISION', band.bandId, '修订后该局部标尺失效，条带回到“无法唯一决定”状态', { rf }),
    );
  }
  return attachDiag(base, diagnostics);
}

function attachDiag(base: MwEstimate, diagnostics: Diagnostic[]): MwEstimate {
  if (diagnostics.length) {
    // 诊断在 reducer 聚合，这里并入 reasonCodes
    for (const d of diagnostics) if (d.outcome) base.reasonCodes.push(d.code);
  }
  return base;
}
