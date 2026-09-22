import type {
  Diagnostic, LaneBoundary, LanePath, PixelPoint, Scale, ScaleSegment,
} from '../shared/types.js';
import { sha256 } from '../shared/id.js';

/** 由泳道中心线折线构建弧长坐标路径（“微笑”弯曲时每条泳道有自己的路径） */
export function buildLanePath(boundary: LaneBoundary): LanePath {
  const pts = boundary.centerline;
  const arc: number[] = [0];
  for (let i = 1; i < pts.length; i++) {
    const dx = pts[i].x - pts[i - 1].x;
    const dy = pts[i].y - pts[i - 1].y;
    arc.push(arc[i - 1] + Math.hypot(dx, dy));
  }
  return { laneId: boundary.laneId, points: pts, arc, total: arc[arc.length - 1] ?? 0 };
}

/** 像素点 → 泳道弧长坐标 s（最近投影），返回 s 与到路径的距离（残差证据） */
export function pixelToS(path: LanePath, p: PixelPoint): { s: number; distance: number } {
  let bestS = 0;
  let bestDist = Infinity;
  for (let i = 0; i < path.points.length - 1; i++) {
    const a = path.points[i];
    const b = path.points[i + 1];
    const abx = b.x - a.x;
    const aby = b.y - a.y;
    const len2 = abx * abx + aby * aby;
    const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * abx + (p.y - a.y) * aby) / len2));
    const qx = a.x + t * abx;
    const qy = a.y + t * aby;
    const d = Math.hypot(p.x - qx, p.y - qy);
    if (d < bestDist) {
      bestDist = d;
      const segLen = path.arc[i + 1] - path.arc[i];
      bestS = path.arc[i] + t * segLen;
    }
  }
  return { s: bestS, distance: bestDist };
}

export class NonMonotonicScaleError extends Error {
  constructor(public detail: string) {
    super(detail);
  }
}

export interface LadderPointInput {
  bandId: string;
  s: number;
  bp: number;
}

/**
 * 构建局部标尺：log10(bp) 对弧长 s 的分段线性插值。
 * 每段携带有效区域 [s0, s1]；整体有效区域为 ladder 点覆盖范围。
 * 非单调（s 随 bp 顺序不递减迁移距离）抛 NonMonotonicScaleError → semantic_unsolvable。
 */
export function buildScale(points: LadderPointInput[], wideGapFactor = 2.5): Scale {
  if (points.length < 2) throw new NonMonotonicScaleError('ladder needs >= 2 points');
  const sorted = [...points].sort((a, b) => a.s - b.s);
  for (let i = 1; i < sorted.length; i++) {
    if (!(sorted[i].bp < sorted[i - 1].bp)) {
      throw new NonMonotonicScaleError(
        `non-monotonic ladder: s=${sorted[i].s.toFixed(1)} has bp=${sorted[i].bp} >= previous bp=${sorted[i - 1].bp}`,
      );
    }
    if (sorted[i].s === sorted[i - 1].s) {
      throw new NonMonotonicScaleError(`duplicate s=${sorted[i].s}`);
    }
  }
  const segments: ScaleSegment[] = [];
  const gaps: number[] = [];
  for (let i = 0; i < sorted.length - 1; i++) gaps.push(sorted[i + 1].s - sorted[i].s);
  const medianGap = [...gaps].sort((a, b) => a - b)[Math.floor(gaps.length / 2)] ?? 1;
  for (let i = 0; i < sorted.length - 1; i++) {
    const a = sorted[i];
    const b = sorted[i + 1];
    segments.push({
      id: `seg_${sha256(`${a.bandId}|${b.bandId}|${a.s}|${b.s}`).slice(0, 16)}`,
      index: i,
      s0: a.s,
      s1: b.s,
      logBp0: Math.log10(a.bp),
      logBp1: Math.log10(b.bp),
      wideGap: b.s - a.s > wideGapFactor * medianGap,
    });
  }
  // 残差：用“去掉该点后的相邻段”回算该点拟合值（leave-one-out）
  const residuals = sorted.map((p, i) => {
    let fittedLog: number;
    if (i === 0) {
      const seg = segments[0];
      fittedLog = seg.logBp0 + ((p.s - seg.s0) / (seg.s1 - seg.s0)) * (seg.logBp1 - seg.logBp0);
    } else if (i === sorted.length - 1) {
      const seg = segments[segments.length - 1];
      fittedLog = seg.logBp0 + ((p.s - seg.s0) / (seg.s1 - seg.s0)) * (seg.logBp1 - seg.logBp0);
    } else {
      const prev = sorted[i - 1];
      const next = sorted[i + 1];
      const l0 = Math.log10(prev.bp);
      const l1 = Math.log10(next.bp);
      fittedLog = l0 + ((p.s - prev.s) / (next.s - prev.s)) * (l1 - l0);
    }
    const fittedBp = 10 ** fittedLog;
    return { bandId: p.bandId, s: p.s, nominalBp: p.bp, fittedBp, residualLog10: Math.log10(p.bp) - fittedLog };
  });
  return {
    segments,
    validRegion: { sLo: sorted[0].s, sHi: sorted[sorted.length - 1].s },
    ladderPoints: sorted.map((p) => ({ s: p.s, bp: p.bp, bandId: p.bandId })),
    residuals,
  };
}

export interface MwEstimate {
  bp: number;
  segment: ScaleSegment;
}

/**
 * 在局部标尺上读分子量。s 超出有效区域时返回 invalid（携带原因），
 * 绝不外推伪装成功。
 */
export function estimateMw(scale: Scale, s: number): { ok: true; value: MwEstimate } | { ok: false; reason: string } {
  if (s < scale.validRegion.sLo || s > scale.validRegion.sHi) {
    return { ok: false, reason: `s=${s.toFixed(1)} 超出标尺有效区域 [${scale.validRegion.sLo.toFixed(1)}, ${scale.validRegion.sHi.toFixed(1)}]` };
  }
  const seg = scale.segments.find((g) => s >= g.s0 && s <= g.s1);
  if (!seg) return { ok: false, reason: `s=${s.toFixed(1)} 不在任何插值段内` };
  const logBp = seg.logBp0 + ((s - seg.s0) / (seg.s1 - seg.s0)) * (seg.logBp1 - seg.logBp0);
  return { ok: true, value: { bp: 10 ** logBp, segment: seg } };
}
