import { Diagnostic, MW_UNIT } from './types';

// 局部标尺点：ladder 条带在“去微笑”坐标（yEff）下的标称分子量。
export type RulerPoint = {
  pointId: string;
  bp: number;
  logBp: number;
  yEff: number;
  sourceMaterialId: string; // ladder 标称值材料
  sourceBandId: string; // ladder 条带
};

export type RulerSegment = {
  lower: RulerPoint; // yEff 较小（大分子）
  upper: RulerPoint; // yEff 较大（小分子）
  monotonic: boolean;
};

export type LocalRuler = {
  laneId: string;
  unit: typeof MW_UNIT;
  coordBasis: string;
  points: RulerPoint[]; // 按 yEff 升序
  segments: RulerSegment[];
  monotonic: boolean;
  validRegion: { yEffMin: number; yEffMax: number; bpMin: number; bpMax: number } | null;
  diagnostics: Diagnostic[];
};

export type LadderBandInput = {
  bandId: string;
  bp: number;
  yObserved: number; // 观测像素 y
  laneX: number; // 所在 ladder 泳道 x
  sourceMaterialId: string;
};

// 构建某一样品泳道的局部标尺：把 ladder 点换算到该泳道的去微笑坐标。
export function buildLocalRuler(
  caseId: string,
  laneId: string,
  laneX: number,
  ladderBands: LadderBandInput[],
  smileAt: (x: number) => number,
  coordBasis: string,
): LocalRuler {
  const diagnostics: Diagnostic[] = [];
  const points: RulerPoint[] = ladderBands
    .map((b) => ({
      pointId: `rp_${laneId}_${b.bandId}`,
      bp: b.bp,
      logBp: Math.log10(b.bp),
      // 去微笑：ladder 观测 y 减去其泳道偏移，再加上本泳道偏移，
      // 使标尺表达“在本泳道 x 处应出现的像素 y”。
      yEff: b.yObserved - smileAt(b.laneX) + smileAt(laneX),
      sourceMaterialId: b.sourceMaterialId,
      sourceBandId: b.bandId,
    }))
    .sort((a, b) => a.yEff - b.yEff);

  const segments: RulerSegment[] = [];
  let monotonic = true;
  for (let i = 0; i + 1 < points.length; i++) {
    const lower = points[i];
    const upper = points[i + 1];
    // 物理约束：y 增大（迁移更远）⇒ 分子量必须严格减小。
    const segMonotonic = upper.bp < lower.bp && upper.yEff > lower.yEff;
    if (!segMonotonic) {
      monotonic = false;
      diagnostics.push({
        code: 'NON_MONOTONIC_RULER',
        severity: 'error',
        message: `标尺段非单调：${lower.bp} bp (y=${lower.yEff.toFixed(1)} px) 与 ${upper.bp} bp (y=${upper.yEff.toFixed(1)} px) 违反迁移方向约束，该段不可用于插值`,
        position: {
          caseId,
          laneId,
          segment: { lowerPointId: lower.pointId, upperPointId: upper.pointId },
        },
      });
    }
    segments.push({ lower, upper, monotonic: segMonotonic });
  }

  if (points.length < 2) {
    diagnostics.push({
      code: 'SEMANTIC_UNSOLVABLE',
      severity: 'error',
      message: `泳道 ${laneId} 的 ladder 有效条带不足两条（当前 ${points.length}），无法建立局部标尺`,
      position: { caseId, laneId },
    });
    return {
      laneId,
      unit: MW_UNIT,
      coordBasis,
      points,
      segments,
      monotonic: false,
      validRegion: null,
      diagnostics,
    };
  }

  const validSegments = segments.filter((s) => s.monotonic);
  const usable = validSegments.length > 0 ? validSegments : segments;
  const yEffMin = Math.min(...usable.flatMap((s) => [s.lower.yEff, s.upper.yEff]));
  const yEffMax = Math.max(...usable.flatMap((s) => [s.lower.yEff, s.upper.yEff]));
  const bps = usable.flatMap((s) => [s.lower.bp, s.upper.bp]);
  return {
    laneId,
    unit: MW_UNIT,
    coordBasis,
    points,
    segments,
    monotonic,
    validRegion: {
      yEffMin,
      yEffMax,
      bpMin: Math.min(...bps),
      bpMax: Math.max(...bps),
    },
    diagnostics,
  };
}

export type BandObservation = {
  saturated: boolean;
  smear: boolean;
  overlapGroup: string | null;
};

export type MwCandidate = { bp: number; logBp: number; basis: string };

export type MwResult =
  | {
      status: 'ok';
      bp: number;
      logBp: number;
      unit: typeof MW_UNIT;
      segment: { lowerPointId: string; upperPointId: string };
      ladderPointIds: string[];
      diagnostics: Diagnostic[];
    }
  | {
      status: 'candidate';
      candidates: MwCandidate[];
      unit: typeof MW_UNIT;
      reason: string;
      ladderPointIds: string[];
      diagnostics: Diagnostic[];
    }
  | {
      status: 'interval';
      bpMin: number | null;
      bpMax: number | null;
      unit: typeof MW_UNIT;
      reason: string;
      ladderPointIds: string[];
      diagnostics: Diagnostic[];
    }
  | {
      status: 'diagnostic';
      unit: typeof MW_UNIT;
      reason: string;
      ladderPointIds: string[];
      diagnostics: Diagnostic[];
    };

function interpBp(lower: RulerPoint, upper: RulerPoint, yEff: number): { bp: number; logBp: number } {
  const t = (yEff - lower.yEff) / (upper.yEff - lower.yEff);
  const logBp = lower.logBp + t * (upper.logBp - lower.logBp);
  return { bp: Math.pow(10, logBp), logBp };
}

// 分子量推断：饱和/拖尾/重叠只能给候选或区间；有效区间外只给区间。
export function inferMw(
  caseId: string,
  laneId: string,
  bandId: string,
  yObserved: number,
  bandHeightPx: number,
  laneX: number,
  smileAt: (x: number) => number,
  ruler: LocalRuler,
  observation: BandObservation,
  overlapGroupMembers: string[],
): MwResult {
  const yEff = yObserved; // 标尺已换算到本泳道坐标系，直接比较观测 y
  const baseDiag: Diagnostic[] = [];

  if (!ruler.validRegion) {
    return {
      status: 'diagnostic',
      unit: MW_UNIT,
      reason: '局部标尺不可用（ladder 不足或完全非单调），无法给出任何分子量',
      ladderPointIds: [],
      diagnostics: [
        {
          code: 'SEMANTIC_UNSOLVABLE',
          severity: 'error',
          message: `条带 ${bandId} 所在泳道 ${laneId} 无可用局部标尺`,
          position: { caseId, laneId, bandId },
        },
      ],
    };
  }

  const seg = ruler.segments.find(
    (s) => s.monotonic && yEff >= s.lower.yEff && yEff <= s.upper.yEff,
  );
  const brokenSeg = ruler.segments.find(
    (s) => !s.monotonic && yEff >= Math.min(s.lower.yEff, s.upper.yEff) && yEff <= Math.max(s.lower.yEff, s.upper.yEff),
  );

  if (brokenSeg && !seg) {
    return {
      status: 'diagnostic',
      unit: MW_UNIT,
      reason: '条带落在非单调标尺段，语义无解：同一像素区间对应多个分子量',
      ladderPointIds: [brokenSeg.lower.pointId, brokenSeg.upper.pointId],
      diagnostics: [
        {
          code: 'SEMANTIC_UNSOLVABLE',
          severity: 'error',
          message: `条带 ${bandId} (y=${yObserved.toFixed(1)} px) 落在非单调标尺段，无法唯一插值`,
          position: {
            caseId,
            laneId,
            bandId,
            segment: { lowerPointId: brokenSeg.lower.pointId, upperPointId: brokenSeg.upper.pointId },
          },
        },
      ],
    };
  }

  if (!seg) {
    // 有效区间之外：只能给区间，绝不外推出点估计。
    const vr = ruler.validRegion;
    const above = yEff < vr.yEffMin;
    baseDiag.push({
      code: 'OUT_OF_VALID_REGION',
      severity: 'warning',
      message: `条带 ${bandId} (y=${yObserved.toFixed(1)} px) 超出局部标尺有效区间 [${vr.yEffMin.toFixed(1)}, ${vr.yEffMax.toFixed(1)}] px，只能给出区间`,
      position: { caseId, laneId, bandId },
    });
    return {
      status: 'interval',
      bpMin: above ? vr.bpMax : null,
      bpMax: above ? null : vr.bpMin,
      unit: MW_UNIT,
      reason: above ? `大于标尺上限 ${vr.bpMax} bp` : `小于标尺下限 ${vr.bpMin} bp`,
      ladderPointIds: ruler.points.map((p) => p.pointId),
      diagnostics: baseDiag,
    };
  }

  const ladderPointIds = [seg.lower.pointId, seg.upper.pointId];

  if (observation.saturated) {
    // 饱和核心：中心不可信，用条带边缘给区间候选。
    const lo = interpBp(seg.lower, seg.upper, Math.min(yEff + bandHeightPx / 2, seg.upper.yEff));
    const hi = interpBp(seg.lower, seg.upper, Math.max(yEff - bandHeightPx / 2, seg.lower.yEff));
    baseDiag.push({
      code: 'SATURATED_BAND',
      severity: 'warning',
      message: `条带 ${bandId} 核心饱和，真实中心不可知，只能标为候选区间`,
      position: { caseId, laneId, bandId },
    });
    return {
      status: 'candidate',
      candidates: [
        { bp: hi.bp, logBp: hi.logBp, basis: 'saturation:leading-edge' },
        { bp: lo.bp, logBp: lo.logBp, basis: 'saturation:trailing-edge' },
      ],
      unit: MW_UNIT,
      reason: '饱和条带：候选为边缘估计，需人工确认',
      ladderPointIds,
      diagnostics: baseDiag,
    };
  }

  if (observation.overlapGroup) {
    // 重叠：保留全部合法候选（每个成员一种归属），不做唯一决定。
    const center = interpBp(seg.lower, seg.upper, yEff);
    baseDiag.push({
      code: 'OVERLAPPING_BANDS',
      severity: 'warning',
      message: `条带 ${bandId} 与 ${overlapGroupMembers.length - 1} 条条带重叠（组 ${observation.overlapGroup}），保留全部合法候选`,
      position: { caseId, laneId, bandId },
    });
    return {
      status: 'candidate',
      candidates: [
        { bp: center.bp, logBp: center.logBp, basis: `overlap-group:${observation.overlapGroup}:as-resolved-center` },
        ...overlapGroupMembers
          .filter((m) => m !== bandId)
          .map((m) => ({ ...center, basis: `overlap-group:${observation.overlapGroup}:could-be-${m}` })),
      ],
      unit: MW_UNIT,
      reason: '重叠条带：无法唯一决定，全部合法候选并列保留',
      ladderPointIds,
      diagnostics: baseDiag,
    };
  }

  if (observation.smear) {
    const lo = interpBp(seg.lower, seg.upper, Math.min(yEff + bandHeightPx, seg.upper.yEff));
    const hi = interpBp(seg.lower, seg.upper, Math.max(yEff - bandHeightPx / 2, seg.lower.yEff));
    baseDiag.push({
      code: 'SMEARED_BAND',
      severity: 'warning',
      message: `条带 ${bandId} 存在拖尾，只能给出区间`,
      position: { caseId, laneId, bandId },
    });
    return {
      status: 'interval',
      bpMin: lo.bp,
      bpMax: hi.bp,
      unit: MW_UNIT,
      reason: '拖尾条带：前沿/后沿区间',
      ladderPointIds,
      diagnostics: baseDiag,
    };
  }

  const { bp, logBp } = interpBp(seg.lower, seg.upper, yEff);
  return {
    status: 'ok',
    bp,
    logBp,
    unit: MW_UNIT,
    segment: { lowerPointId: seg.lower.pointId, upperPointId: seg.upper.pointId },
    ladderPointIds,
    diagnostics: baseDiag,
  };
}

// 拟合残差：每个 ladder 点相对其左右邻点线性预测的偏差（px）。
export function rulerResiduals(ruler: LocalRuler): { pointId: string; bp: number; residualPx: number }[] {
  const pts = ruler.points;
  const out: { pointId: string; bp: number; residualPx: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    let predicted: number | null = null;
    if (i > 0 && i < pts.length - 1) {
      const a = pts[i - 1];
      const b = pts[i + 1];
      const t = (pts[i].logBp - a.logBp) / (b.logBp - a.logBp);
      predicted = a.yEff + t * (b.yEff - a.yEff);
    } else if (pts.length >= 2 && i === 0) {
      const a = pts[0];
      const b = pts[1];
      predicted = a.yEff; // 端点残差相对最近段
      void b;
    } else if (pts.length >= 2) {
      predicted = pts[pts.length - 1].yEff;
    }
    out.push({
      pointId: pts[i].pointId,
      bp: pts[i].bp,
      residualPx: predicted === null ? 0 : pts[i].yEff - predicted,
    });
  }
  return out;
}
