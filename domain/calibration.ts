import type {
  CalibrationSegment,
  Diagnostic,
  MwCandidate,
  ParamSet,
  UnitMass
} from './types';

/**
 * 分子量标尺：log(标称值) 对迁移弧长 t 做分段线性插值。
 * 每一段携带自己的有效区域；非单调段（质量未随迁移下降）直接判无效，
 * 缺失 ladder 带跨越的区段标为 unanchored 时由上游过滤。
 */

export interface LadderPoint {
  ladderBandId: string;
  t: number;
  mass: number;
  unit: UnitMass;
}

export function buildSegments(points: LadderPoint[], param: ParamSet): {
  segments: CalibrationSegment[];
  diagnostics: Diagnostic[];
} {
  const sorted = [...points].sort((a, b) => a.t - b.t);
  const segments: CalibrationSegment[] = [];
  const diagnostics: Diagnostic[] = [];
  for (let i = 0; i < sorted.length - 1; i++) {
    const p0 = sorted[i];
    const p1 = sorted[i + 1];
    const monotone = p1.mass < p0.mass;
    const dt = p1.t - p0.t;
    const a = monotone && dt > 0 ? (Math.log10(p1.mass) - Math.log10(p0.mass)) / dt : 0;
    const b = monotone && dt > 0 ? Math.log10(p0.mass) - a * p0.t : 0;
    const id = `seg_${p0.ladderBandId}_${p1.ladderBandId}`;
    if (!monotone) {
      diagnostics.push({
        code: 'LADDER_NONMONOTONIC_SEGMENT',
        message: `非单调标尺：t=${p0.t.toFixed(1)}px 处 ${p0.mass}${p0.unit} -> t=${p1.t.toFixed(1)}px 处 ${p1.mass}${p1.unit}，质量未随迁移下降`,
        location: { kind: 'material', materialId: p1.ladderBandId }
      });
    }
    segments.push({
      id,
      ladderBandId: p0.ladderBandId,
      ladderBandIdNext: p1.ladderBandId,
      nominalLow: p0.mass,
      nominalHigh: p1.mass,
      unit: p0.unit,
      tLow: p0.t,
      tHigh: p1.t,
      a,
      b,
      valid: monotone && dt > 0,
      invalidReason: monotone ? null : '非单调标称序列'
    });
  }
  return { segments, diagnostics };
}

export function validRange(segments: CalibrationSegment[]): { low: number; high: number } | null {
  const valid = segments.filter((s) => s.valid);
  if (valid.length === 0) return null;
  return { low: Math.min(...valid.map((s) => s.tLow)), high: Math.max(...valid.map((s) => s.tHigh)) };
}

export function residuals(points: LadderPoint[], segments: CalibrationSegment[]) {
  return points.map((p) => {
    const seg = segments.find((s) => s.valid && s.ladderBandId === p.ladderBandId);
    const fitted = seg ? Math.pow(10, seg.a * p.t + seg.b) : p.mass;
    return {
      ladderBandId: p.ladderBandId,
      t: p.t,
      nominal: p.mass,
      fitted,
      residual: Math.log10(fitted) - Math.log10(p.mass)
    };
  });
}

function invertSegment(seg: CalibrationSegment, mass: number): number {
  return (Math.log10(mass) - seg.b) / seg.a;
}

/**
 * 条带分子量推断。
 * - 正常：落在有效段内 => 唯一 point 候选。
 * - 饱和：峰顶不可信，按 FWHM 边缘迁移量给出区间 interval。
 * - 重叠/歧义：保留全部合法候选 ambiguous。
 * - 超出有效区域且不允许外推：返回 OUTSIDE_VALID_REGION 诊断，不伪造数值。
 */
export function inferMw(args: {
  t: number;
  fwhmPx: number;
  saturated: boolean;
  smeared: boolean;
  ambiguousMasses?: { mass: number; reason: string }[];
  segments: CalibrationSegment[];
  param: ParamSet;
}): { candidates: MwCandidate[]; diagnostics: Diagnostic[] } {
  const { t, fwhmPx, saturated, smeared, ambiguousMasses, segments, param } = args;
  const diagnostics: Diagnostic[] = [];
  const range = validRange(segments);

  if (!range) {
    diagnostics.push({
      code: 'LADDER_NO_VALID_SEGMENT',
      message: '不存在任何有效校准段（非单调或缺带），分子量无法标定',
      location: null
    });
    return { candidates: [], diagnostics };
  }

  const inside = t >= range.low && t <= range.high;
  if (!inside && !param.extrapolate) {
    diagnostics.push({
      code: 'OUTSIDE_VALID_REGION',
      message: `条带迁移 t=${t.toFixed(1)}px 位于标尺有效区域 [${range.low.toFixed(1)}, ${range.high.toFixed(1)}] 之外，禁止外推`,
      location: null
    });
    return { candidates: [], diagnostics };
  }

  const seg = pickSegment(segments, t, param);
  if (!seg) {
    diagnostics.push({
      code: 'LADDER_NO_VALID_SEGMENT',
      message: `t=${t.toFixed(1)}px 附近没有有效插值段`,
      location: null
    });
    return { candidates: [], diagnostics };
  }
  const massAt = (tt: number) => Math.pow(10, seg.a * tt + seg.b);

  if (ambiguousMasses && ambiguousMasses.length > 1) {
    if (saturated) diagnostics.push({ code: 'BAND_SATURATED', message: '条带饱和，质量只能作为候选', location: null });
    return {
      candidates: ambiguousMasses.map((m, i) => ({
        mass: m.mass,
        unit: seg.unit,
        segmentId: seg.id,
        kind: 'ambiguous',
        reason: m.reason || `重叠/歧义候选 ${i + 1}`
      })),
      diagnostics: [
        ...diagnostics,
        { code: 'BAND_OVERLAP', message: '两条带重叠，保留全部合法候选', location: null }
      ]
    };
  }

  if (saturated || smeared) {
    const tLo = Math.min(t, t + fwhmPx / 2);
    const tHi = Math.max(t, t - fwhmPx / 2);
    const low = Math.min(massAt(tLo), massAt(tHi));
    const high = Math.max(massAt(tLo), massAt(tHi));
    if (saturated) {
      diagnostics.push({
        code: 'BAND_SATURATED',
        message: `饱和条带：峰顶强度被截断，质量只能给区间 [${Math.round(low)}, ${Math.round(high)}] ${seg.unit}`,
        location: null
      });
    }
    if (smeared) {
      diagnostics.push({
        code: 'BAND_SMEARED',
        message: `拖尾/涂抹条带：峰形不对称，质量给区间 [${Math.round(low)}, ${Math.round(high)}] ${seg.unit}`,
        location: null
      });
    }
    return {
      candidates: [
        {
          mass: massAt(t),
          low,
          high,
          unit: seg.unit,
          segmentId: seg.id,
          kind: 'interval',
          reason: saturated ? '饱和：按 FWHM 边缘迁移量给区间' : '拖尾：按 FWHM 边缘迁移量给区间'
        }
      ],
      diagnostics
    };
  }

  return {
    candidates: [
      {
        mass: massAt(t),
        unit: seg.unit,
        segmentId: seg.id,
        kind: 'point',
        reason: '有效段内 log-linear 插值'
      }
    ],
    diagnostics
  };
}

function pickSegment(segments: CalibrationSegment[], t: number, param: ParamSet): CalibrationSegment | null {
  const hit = segments.find((s) => s.valid && t >= s.tLow && t <= s.tHigh);
  if (hit) return hit;
  if (param.extrapolate) {
    const valid = segments.filter((s) => s.valid).sort((a, b) => a.tLow - b.tLow);
    if (valid.length === 0) return null;
    if (t < valid[0].tLow) return valid[0];
    return valid[valid.length - 1];
  }
  return null;
}

/** 由期望的质量反求 t（复核页点击分子量 -> 回到 ladder 点与插值段） */
export function locateMass(segments: CalibrationSegment[], mass: number): { seg: CalibrationSegment; t: number } | null {
  for (const seg of segments) {
    if (!seg.valid) continue;
    const lo = Math.min(seg.nominalLow, seg.nominalHigh);
    const hi = Math.max(seg.nominalLow, seg.nominalHigh);
    if (mass >= lo && mass <= hi) return { seg, t: invertSegment(seg, mass) };
  }
  return null;
}
