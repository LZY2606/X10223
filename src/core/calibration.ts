import type {
  BandAnnotation,
  CalibrationFit,
  CalibrationSegment,
  LadderMaterial,
  LaneAnnotation,
  SegmentStatus,
} from './types';
import { stableId } from '../shared/ids';
import type { Diagnostic } from '../shared/diagnostic';

export const CALIBRATION_PARAM_VERSION = 'calib.v4';

export interface LadderMatch {
  band: BandAnnotation;
  nominalId: string;
  bp: number;
}

/**
 * 按“s 升 ↔ bp 降”的单调性匹配 ladder 道条带与标称值，
 * 允许 ladder 缺带，也允许杂散峰未匹配。
 *
 * laneBands 已按 s 升序、nominals 已按 bp 降序；
 * 因此按下标顺序的公共子序列天然满足 s 升、bp 降（LCS 式 DP）。
 */
/**
 * 匹配 ladder 道条带与标称值。
 * 1) 若条带已带 nominalId（标注/配方来源），直接采用该绑定（能表达“错标/非单调”）。
 * 2) 否则（自动检测）在所有单调对齐中选 log(bp)~s 全局线性残差最小者，
 *    这能正确识别 ladder 缺带（缺带处间隙变大）。
 */
export function matchLadderBands(
  ladder: LadderMaterial,
  lane: LaneAnnotation,
  bands: BandAnnotation[],
): { matches: LadderMatch[]; diagnostics: Diagnostic[] } {
  const laneBands = bands
    .filter((b) => b.laneId === lane.laneId)
    .sort((a, b) => (a.arcLengthPx ?? 0) - (b.arcLengthPx ?? 0));
  const nominals = ladder.nominals
    .filter((n) => n.quantity.bp !== null)
    .sort((a, b) => b.quantity.bp! - a.quantity.bp!);
  const diagnostics: Diagnostic[] = [];

  if (laneBands.length === 0 || nominals.length === 0) {
    diagnostics.push({
      code: 'missing-ladder-band',
      severity: 'error',
      message: laneBands.length === 0 ? 'ladder 道未检测到任何条带' : 'ladder 标称值为空',
      location: { laneId: lane.laneId },
    });
    return { matches: [], diagnostics };
  }

  let matches: LadderMatch[];
  if (laneBands.every((b) => b.nominalId)) {
    const byId = new Map(nominals.map((n) => [n.nominalId, n]));
    matches = [];
    for (const band of laneBands) {
      const nominal = byId.get(band.nominalId!);
      if (nominal) matches.push({ band, nominalId: nominal.nominalId, bp: nominal.quantity.bp! });
    }
    matches.sort((a, b) => (a.band.arcLengthPx ?? 0) - (b.band.arcLengthPx ?? 0));
  } else {
    matches = bestLinearAlignment(laneBands, nominals);
  }

  const matchedNominals = new Set(matches.map((m) => m.nominalId));
  const matchedBands = new Set(matches.map((m) => m.band.bandId));
  for (const nominal of nominals) {
    if (!matchedNominals.has(nominal.nominalId)) {
      diagnostics.push({
        code: 'missing-ladder-band',
        severity: 'warning',
        message: `ladder 缺带：未检测到标称条带 ${nominal.quantity.raw}`,
        location: { laneId: lane.laneId },
      });
    }
  }
  for (const band of laneBands) {
    if (!matchedBands.has(band.bandId)) {
      diagnostics.push({
        code: 'missing-ladder-band',
        severity: 'info',
        message: `ladder 道存在未与标称值匹配的候选条带（y=${band.center.y}px）`,
        location: { laneId: lane.laneId, bandId: band.bandId, y: band.center.y },
      });
    }
  }

  for (let k = 1; k < matches.length; k++) {
    const prev = matches[k - 1]!;
    const cur = matches[k]!;
    if (cur.bp >= prev.bp || (cur.band.arcLengthPx ?? 0) <= (prev.band.arcLengthPx ?? 0)) {
      diagnostics.push({
        code: 'non-monotonic-calibration',
        severity: 'error',
        message: `ladder 标尺非单调：${prev.bp}bp@${prev.band.arcLengthPx}px → ${cur.bp}bp@${cur.band.arcLengthPx}px`,
        location: { laneId: lane.laneId, bandId: cur.band.bandId, y: cur.band.center.y },
      });
    }
  }
  return { matches, diagnostics };
}

/**
 * 在“s 升 ↔ bp 降”的全部对齐中，选全局 log10(bp)~s 线性残差最小者。
 * 标称数很少（<=12），直接枚举单调对齐（组合数 C(m,n)）。
 */
function bestLinearAlignment(
  laneBands: BandAnnotation[],
  nominals: LadderMaterial['nominals'],
): LadderMatch[] {
  const n = laneBands.length;
  const m = nominals.length;
  let best: LadderMatch[] = [];
  let bestCost = Infinity;
  const chosen: number[] = [];
  const consider = () => {
    if (chosen.length !== n) return;
    const pairs = chosen.map((j, i) => ({
      s: laneBands[i]!.arcLengthPx ?? 0,
      z: Math.log10(nominals[j]!.quantity.bp!),
      band: laneBands[i]!,
      nominal: nominals[j]!,
    }));
    const { c0, c1 } = leastSquares(pairs.map((p) => ({ s: p.s, z: p.z })));
    let cost = 0;
    for (const p of pairs) cost += (p.z - (c0 - c1 * p.s)) ** 2;
    // 惩罚：大量标称未使用，避免总配到最容易的两点。
    cost += (m - n) * 1e-9;
    if (cost < bestCost) {
      bestCost = cost;
      best = pairs.map((p) => ({ band: p.band, nominalId: p.nominal.nominalId, bp: p.nominal.quantity.bp! }));
    }
  };
  const recurse = (start: number) => {
    if (chosen.length === n) return consider();
    for (let j = start; j < m; j++) {
      chosen.push(j);
      recurse(j + 1);
      chosen.pop();
    }
  };
  recurse(0);
  return best;
}

export function buildCalibration(
  ladder: LadderMaterial,
  lane: LaneAnnotation,
  bands: BandAnnotation[],
): CalibrationFit {
  const { matches, diagnostics } = matchLadderBands(ladder, lane, bands);
  const ordered = [...matches].sort((a, b) => (a.band.arcLengthPx ?? 0) - (b.band.arcLengthPx ?? 0));

  const globalFit = leastSquares(
    ordered.map((m) => ({ s: m.band.arcLengthPx ?? 0, z: Math.log10(m.bp) })),
  );

  const matchedNominalSet = new Set(ordered.map((m) => m.nominalId));
  const orderedNominals = ladder.nominals
    .filter((n) => n.quantity.bp !== null)
    .sort((a, b) => b.quantity.bp! - a.quantity.bp!);

  const segments: CalibrationSegment[] = [];
  for (let k = 0; k < ordered.length - 1; k++) {
    const high = ordered[k]!;
    const low = ordered[k + 1]!;
    const s1 = high.band.arcLengthPx ?? 0;
    const s2 = low.band.arcLengthPx ?? 0;
    const z1 = Math.log10(high.bp);
    const z2 = Math.log10(low.bp);
    const slope = s2 === s1 ? 0 : (z1 - z2) / (s2 - s1);
    const intercept = z1 + slope * s1;
    let status: SegmentStatus = 'valid';
    if (!(slope > 0)) status = 'non-monotonic';
    else if (spansMissing(high.nominalId, low.nominalId, orderedNominals, matchedNominalSet))
      status = 'missing-span';

    segments.push({
      segmentId: stableId('seg', lane.laneId, high.band.bandId, low.band.bandId, CALIBRATION_PARAM_VERSION),
      laneId: lane.laneId,
      sMin: s1,
      sMax: s2,
      intercept,
      slope,
      status,
      lowBandId: low.band.bandId,
      highBandId: high.band.bandId,
      yMin: Math.min(high.band.center.y, low.band.center.y),
      yMax: Math.max(high.band.center.y, low.band.center.y),
    });
  }
  if (ordered.length < 2) {
    diagnostics.push({
      code: 'missing-ladder-band',
      severity: 'error',
      message: `仅匹配到 ${ordered.length} 个 ladder 点，无法建立插值段`,
      location: { laneId: lane.laneId },
    });
  }

  const residuals = ordered.map((m) => {
    const s = m.band.arcLengthPx ?? 0;
    const z = Math.log10(m.bp);
    const fittedS = globalFit.c1 !== 0 ? (globalFit.c0 - z) / globalFit.c1 : s;
    return { bandId: m.band.bandId, s, fittedS, residualPx: Math.round((s - fittedS) * 100) / 100 };
  });

  return {
    fitId: stableId('fit', lane.laneId, ordered.map((m) => m.band.bandId), CALIBRATION_PARAM_VERSION),
    laneId: lane.laneId,
    paramVersion: CALIBRATION_PARAM_VERSION,
    residuals,
    segments,
    diagnostics,
    inputSummary: {
      ladderMaterialId: ladder.materialId,
      ladderBands: ordered.map((m) => ({
        bandId: m.band.bandId,
        nominalId: m.nominalId,
        bp: m.bp,
        s: m.band.arcLengthPx,
      })),
      coordinate: 'arc-length-px',
    },
    parentDepends: [lane.laneId, ladder.materialId, ...ordered.map((m) => m.band.bandId)],
  };
}

function spansMissing(
  highNom: string,
  lowNom: string,
  orderedNominals: LadderMaterial['nominals'],
  matched: Set<string>,
): boolean {
  const hi = orderedNominals.findIndex((n) => n.nominalId === highNom);
  const lo = orderedNominals.findIndex((n) => n.nominalId === lowNom);
  if (hi < 0 || lo < 0) return false;
  for (let k = hi + 1; k < lo; k++) {
    if (!matched.has(orderedNominals[k]!.nominalId)) return true;
  }
  return false;
}

/** 全局最小二乘 z = c0 - c1*s （c1>0）。 */
export function leastSquares(points: { s: number; z: number }[]): { c0: number; c1: number } {
  if (points.length === 0) return { c0: 0, c1: 0 };
  const n = points.length;
  const sx = points.reduce((a, p) => a + p.s, 0);
  const sz = points.reduce((a, p) => a + p.z, 0);
  const sxx = points.reduce((a, p) => a + p.s * p.s, 0);
  const sxz = points.reduce((a, p) => a + p.s * p.z, 0);
  const denom = n * sxx - sx * sx;
  if (denom === 0) return { c0: sz / n, c1: 0 };
  const slope = (n * sxz - sx * sz) / denom; // z 对 s 的斜率，应为负
  const c0 = (sz - slope * sx) / n;
  return { c0, c1: -slope };
}
