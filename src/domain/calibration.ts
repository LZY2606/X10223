import type {
  BandAnnotation, CalibrationAnchor, CalibrationResult, Diagnostic,
  InterpSegment, LadderSpecMaterial, ValidRegion,
} from '../shared/types.js';
import { contentId } from '../shared/digest.js';

export interface LadderBandAtS { ordinal: number; bandId: string; s: number; saturated: boolean }

// 将 ladder 道上的人工条带按迁移距离排序并与标称槽位对齐。
// 缺带：bands 数量少于标称条目时，按最佳一一对应（允许间隔），未命中槽位记 missing。
export function alignLadderBands(
  spec: LadderSpecMaterial,
  sOf: (bandId: string) => { s: number; saturated: boolean } | undefined,
  ladderBands: BandAnnotation[],
): { aligned: LadderBandAtS[]; missingOrdinals: number[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const measured = ladderBands
    .map((b) => ({ bandId: b.id, ordinal: b.ordinal, ...(sOf(b.id) ?? { s: NaN, saturated: false }) }))
    .sort((a, b) => a.s - b.s);

  const usable = spec.entries.filter((e) => e.nominalBp !== null);
  const aligned: LadderBandAtS[] = [];
  const missingOrdinals: number[] = [];

  // 最长公共子序列式单调对齐：允许跳过标称条目（缺带）与多余测量峰，顺序不可颠倒。
  const m = measured.length, n = usable.length;
  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  const take: boolean[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(false));
  for (let i2 = 1; i2 <= m; i2++) {
    for (let j2 = 1; j2 <= n; j2++) {
      const skipMeasured = dp[i2 - 1][j2];
      const skipNominal = dp[i2][j2 - 1];
      const use = dp[i2 - 1][j2 - 1] + 1;
      if (use >= skipMeasured && use >= skipNominal) {
        dp[i2][j2] = use; take[i2][j2] = true;
      } else {
        dp[i2][j2] = Math.max(skipMeasured, skipNominal);
      }
    }
  }
  const usedNominal = new Set<number>();
  let i = m, j = n;
  const pairs: { mi: number; ni: number }[] = [];
  while (i > 0 && j > 0) {
    if (take[i][j] && dp[i][j] === dp[i - 1][j - 1] + 1) {
      pairs.push({ mi: i - 1, ni: j - 1 });
      usedNominal.add(j - 1); i--; j--;
    } else j--;
  }
  pairs.reverse();
  // 缺带：未被匹配的标称槽位
  for (let k = 0; k < n; k++) if (!usedNominal.has(k)) missingOrdinals.push(usable[k].ordinal);

  for (const { mi, ni } of pairs) {
    const band = measured[mi];
    aligned.push({ ordinal: usable[ni].ordinal, bandId: band.bandId, s: band.s, saturated: band.saturated });
  }
  aligned.sort((a, b) => a.s - b.s);
  if (missingOrdinals.length) {
    diagnostics.push({
      code: 'LADDER_MISSING_BAND',
      path: spec.id,
      message: `ladder 缺带 ${missingOrdinals.length} 个标称槽位：${missingOrdinals.join(',')}；对应区间改为跨段插值`,
      detail: { missingOrdinals },
    });
  }
  return { aligned, missingOrdinals, diagnostics };
}

// 局部对数插值校准：bp 对弧长 s 分段线性（log bp），仅在有效区内成立。
export function buildCalibration(
  ladderLaneId: string,
  spec: LadderSpecMaterial,
  aligned: LadderBandAtS[],
  missingOrdinals: number[],
): CalibrationResult {
  const byOrdinal = new Map(spec.entries.map((e) => [e.ordinal, e]));
  const notes: string[] = [];
  const diagnostics: Diagnostic[] = [];

  const anchors: CalibrationAnchor[] = aligned.map((a) => {
    const entry = byOrdinal.get(a.ordinal)!;
    return {
      nominalId: entry.id,
      ordinal: a.ordinal,
      s: Number(a.s.toFixed(2)),
      bp: entry.nominalBp!,
      matchedBandId: a.bandId,
      residualVsGlobalLogFit: 0,
    };
  });

  // 非单调：s 增大而 bp 不单调下降
  let monotonic = true;
  for (let k = 1; k < anchors.length; k++) {
    if (!(anchors[k].bp < anchors[k - 1].bp) || !(anchors[k].s > anchors[k - 1].s)) {
      monotonic = false;
      diagnostics.push({
        code: 'SEMANTIC_NO_SOLUTION',
        path: `ladder:${ladderLaneId}`,
        message: `非单调标尺：s ${anchors[k - 1].s}->${anchors[k].s} 时 bp ${anchors[k - 1].bp}->${anchors[k].bp}`,
        detail: { betweenOrdinals: [anchors[k - 1].ordinal, anchors[k].ordinal] },
      });
    }
  }

  // 全局 log 线性拟合仅用于残差展示，不用于推断
  if (anchors.length >= 2) {
    const xs = anchors.map((a) => a.s);
    const ys = anchors.map((a) => Math.log(a.bp));
    const mx = xs.reduce((a, b) => a + b, 0) / xs.length;
    const my = ys.reduce((a, b) => a + b, 0) / ys.length;
    const denom = xs.reduce((a, x, k) => a + (x - mx) * (ys[k] - my), 0);
    const slope = denom === 0 ? 0 : denom / xs.reduce((a, x) => a + (x - mx) ** 2, 0);
    const intercept = my - slope * mx;
    for (const a of anchors) {
      const fitBp = Math.exp(slope * a.s + intercept);
      a.residualVsGlobalLogFit = Number(((a.bp - fitBp) / fitBp).toFixed(4));
    }
  }

  const segments: InterpSegment[] = [];
  if (monotonic) {
    for (let k = 1; k < anchors.length; k++) {
      const prev = anchors[k - 1], cur = anchors[k];
      const skipped: number[] = [];
      for (const ord of missingOrdinals) if (ord > prev.ordinal && ord < cur.ordinal) skipped.push(ord);
      segments.push({
        id: contentId('seg', [ladderLaneId, prev.ordinal, cur.ordinal]),
        fromAnchorOrdinal: prev.ordinal,
        toAnchorOrdinal: cur.ordinal,
        sFrom: prev.s, sTo: cur.s,
        bpFrom: prev.bp, bpTo: cur.bp,
        skippedNominalOrdinals: skipped,
      });
    }
  } else {
    notes.push('标尺非单调：未生成任何插值段，分子量推断语义无解。');
  }

  const validRegion: ValidRegion = anchors.length >= 2 && monotonic
    ? { sMin: anchors[0].s, sMax: anchors[anchors.length - 1].s, unit: 'px-arc' }
    : { sMin: NaN, sMax: NaN, unit: 'px-arc' };

  return { ladderLaneId, anchors, segments, validRegion, monotonic, notes };
}

// 分段 log 线性插值
export function interpBp(cal: CalibrationResult, s: number): { bp: number | null; segmentId: string | null; reason?: string } {
  const { sMin, sMax } = cal.validRegion;
  if (!cal.monotonic || cal.segments.length === 0) {
    return { bp: null, segmentId: null, reason: '标尺非单调或无可用锚点' };
  }
  if (s < sMin - 1e-6 || s > sMax + 1e-6) {
    return { bp: null, segmentId: null, reason: `s=${s.toFixed(1)} 超出有效区 [${sMin.toFixed(1)}, ${sMax.toFixed(1)}]px-arc` };
  }
  for (const seg of cal.segments) {
    if (s >= seg.sFrom - 1e-6 && s <= seg.sTo + 1e-6) {
      const t = (s - seg.sFrom) / ((seg.sTo - seg.sFrom) || 1);
      const logBp = Math.log(seg.bpFrom) + t * (Math.log(seg.bpTo) - Math.log(seg.bpFrom));
      return { bp: Number(Math.exp(logBp).toFixed(1)), segmentId: seg.id };
    }
  }
  return { bp: null, segmentId: null, reason: '未命中任何插值段' };
}
