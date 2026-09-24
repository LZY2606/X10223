import type {
  BandCandidateResult,
  CalibrationParams,
  CalibrationResult,
  CalibrationSegment,
  Diagnostic,
  Judgment,
  LadderSpec
} from '../types';
import { SemanticImpossibleError, diag } from '../diagnostic';
import { contentId, digestOf } from '../ids';

export interface CalibrationInput {
  spec: LadderSpec;
  bands: BandCandidateResult;
  params: CalibrationParams;
  parents: string[];
  now: string;
}

interface Match {
  bandId: string;
  label: string;
  mass: number;
  order: number;
  s: number;
}

const SKIP_PENALTY = 0.22;

// 标尺点与观测条带的顺序匹配（允许缺带/杂带），DP 求解
function alignBands(
  observed: { id: string; s: number }[],
  nominal: { label: string; mass: number; order: number }[],
  tolerance: number
): { matches: Match[]; missingLabels: string[]; extraBandIds: string[] } {
  const n = observed.length;
  const m = nominal.length;
  if (m < 2 || n < 2) return { matches: [], missingLabels: nominal.map(x => x.label), extraBandIds: observed.map(x => x.id) };
  const sMin = observed[0].s;
  const sMax = observed[n - 1].s;
  const span = Math.max(1e-9, sMax - sMin);
  const cost: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(Infinity));
  const back: number[][] = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-1));
  cost[0][0] = 0;
  for (let i = 0; i <= n; i++) {
    for (let j = 0; j <= m; j++) {
      if (i === 0 && j === 0) continue;
      const c = cost[i][j];
      // 跳过一个观测（杂带）
      if (i > 0 && cost[i - 1][j] + SKIP_PENALTY < c) {
        cost[i][j] = cost[i - 1][j] + SKIP_PENALTY;
        back[i][j] = 1;
      }
      // 跳过一个标称（缺带）
      if (j > 0 && cost[i][j - 1] + SKIP_PENALTY < cost[i][j]) {
        cost[i][j] = cost[i][j - 1] + SKIP_PENALTY;
        back[i][j] = 2;
      }
      if (i > 0 && j > 0) {
        const obsNorm = (observed[i - 1].s - sMin) / span;
        const nomNorm = m > 1 ? (nominal[j - 1].order - nominal[0].order) / (nominal[m - 1].order - nominal[0].order) : 0;
        const d = Math.abs(obsNorm - nomNorm);
        const penalty = d <= tolerance ? d : 1.5 + d;
        if (cost[i - 1][j - 1] + penalty < cost[i][j]) {
          cost[i][j] = cost[i - 1][j - 1] + penalty;
          back[i][j] = 3;
        }
      }
    }
  }
  const matches: Match[] = [];
  const usedBands = new Set<string>();
  const usedLabels = new Set<string>();
  let i = n, j = m;
  while (i > 0 || j > 0) {
    const b = back[i][j];
    if (b === 3) {
      const ob = observed[i - 1], no = nominal[j - 1];
      matches.push({ bandId: ob.id, label: no.label, mass: no.mass, order: no.order, s: ob.s });
      usedBands.add(ob.id);
      usedLabels.add(no.label);
      i--; j--;
    } else if (b === 2) {
      j--;
    } else if (b === 1) {
      i--;
    } else {
      if (i > 0) i--;
      else if (j > 0) j--;
    }
  }
  matches.reverse();
  return {
    matches,
    missingLabels: nominal.filter(x => !usedLabels.has(x.label)).map(x => x.label),
    extraBandIds: observed.filter(x => !usedBands.has(x.id)).map(x => x.id)
  };
}

export function calibrate(input: CalibrationInput): {
  result: CalibrationResult;
  diagnostics: Diagnostic[];
  judgments: Judgment[];
} {
  const { spec, bands, params, parents, now } = input;
  const diagnostics: Diagnostic[] = [];
  const judgments: Judgment[] = [];

  if (!spec.bands.length) {
    throw new SemanticImpossibleError([
      diag('LADDER_EMPTY', 'semantic-impossible', 'ladder 标称值为空，无法校准', { materialId: spec.id, field: 'bands' })
    ]);
  }

  // 非单调标尺：标称迁移顺序上的分子量必须严格单调
  const ordered = [...spec.bands].sort((a, b) => a.order - b.order);
  let nonMonotonic = false;
  for (let k = 1; k < ordered.length; k++) {
    if (ordered[k].mass >= ordered[k - 1].mass) { nonMonotonic = true; break; }
  }
  if (new Set(ordered.map(o => o.order)).size !== ordered.length) nonMonotonic = true;

  const observed = [...bands.bands].sort((a, b) => a.s - b.s).map(b => ({ id: b.id, s: b.s }));
  const { matches, missingLabels, extraBandIds } = alignBands(
    observed,
    ordered.map(o => ({ label: o.label, mass: o.mass, order: o.order })),
    params.calibration.matchTolerance
  );

  const ladderPointId = (label: string) => contentId('lp', { spec: spec.id, label });

  if (nonMonotonic) {
    judgments.push({
      code: 'NONMONOTONIC_RULER',
      message: '非单调标尺：标称分子量沿迁移顺序不严格递减，分子量不可唯一确定',
      severity: 'error',
      evidence: { specId: spec.id, ordered: ordered.map(o => ({ label: o.label, mass: o.mass, order: o.order })) },
      affectedObjectIds: [spec.id, ...bands.bands.map(b => b.id)]
    });
  }
  for (const label of missingLabels) {
    judgments.push({
      code: 'MISSING_LADDER_BAND',
      message: `ladder 缺带：标称 ${label} 未匹配到条带，相邻插值段可信度下降`,
      severity: 'warning',
      evidence: { specId: spec.id, label },
      affectedObjectIds: [ladderPointId(label)]
    });
  }
  if (matches.length < params.calibration.minMatchedBands) {
    diagnostics.push(diag('CALIBRATION_UNDERCONSTRAINED', 'semantic-impossible',
      `ladder 仅匹配 ${matches.length} 个点，少于最少要求 ${params.calibration.minMatchedBands}`,
      { materialId: spec.id, laneId: bands.laneCode, unit: 'dimensionless' }));
  }
  if (nonMonotonic || matches.length < params.calibration.minMatchedBands) {
    const result = emptyCalibration(spec, bands, parents, params, now, matches, ladderPointId, nonMonotonic);
    return { result, diagnostics, judgments };
  }

  // 分段 log(mass) = a*s + b，段内线性；每段标注有效区域
  const segments: CalibrationSegment[] = [];
  for (let k = 1; k < matches.length; k++) {
    const p0 = matches[k - 1], p1 = matches[k];
    const s0 = p0.s, s1 = p1.s;
    const a = (Math.log(p1.mass) - Math.log(p0.mass)) / Math.max(1e-9, s1 - s0);
    const b = Math.log(p0.mass) - a * s0;
    const id = contentId('seg', { spec: spec.id, l0: p0.label, l1: p1.label, s0, s1 });
    segments.push({
      id,
      ladderPointIds: [ladderPointId(p0.label), ladderPointId(p1.label)],
      s0, s1, a, b,
      residual: [],
      validRegion: { s0, s1 }
    });
  }
  const fitResiduals = matches.map(mm => {
    const seg = segments.find(seg => mm.s >= seg.s0 && mm.s <= seg.s1)!;
    const pred = seg.a * mm.s + seg.b;
    const residual = Math.log(mm.mass) - pred;
    seg.residual.push(residual);
    return { s: mm.s, residual, ladderPointId: ladderPointId(mm.label) };
  });

  const id = contentId('calib', { spec: spec.id, bands: bands.id, matches: matches.map(m => [m.bandId, m.label]) });
  const result: CalibrationResult = {
    id,
    type: 'calibration',
    parentIds: parents,
    inputDigest: digestOf({ spec: spec.id, bands: bands.id, pv: params.paramVersion }),
    paramVersion: params.paramVersion,
    computedAt: now,
    diagnostics,
    laneCode: bands.laneCode,
    unit: spec.unit,
    segments,
    ladderAssignments: ordered.map(o => {
      const mt = matches.find(mm => mm.label === o.label);
      return {
        ladderPointId: ladderPointId(o.label),
        bandId: mt?.bandId ?? '',
        nominalMass: o.mass,
        s: mt?.s ?? NaN,
        matched: !!mt
      };
    }),
    nonMonotonic,
    fitResiduals
  };
  diagnostics.push(...(extraBandIds.length ? [diag('LADDER_EXTRA_BAND', 'warning',
    `ladder 泳道有 ${extraBandIds.length} 条未匹配杂带，已排除在标尺之外`, { laneId: bands.laneCode })] : []));
  return { result, diagnostics, judgments };
}

function emptyCalibration(
  spec: LadderSpec,
  bands: BandCandidateResult,
  parents: string[],
  params: CalibrationParams,
  now: string,
  matches: Match[],
  lpId: (label: string) => string,
  nonMonotonic: boolean
): CalibrationResult {
  return {
    id: contentId('calib', { spec: spec.id, bands: bands.id, broken: true }),
    type: 'calibration',
    parentIds: parents,
    inputDigest: digestOf({ spec: spec.id, bands: bands.id, pv: params.paramVersion }),
    paramVersion: params.paramVersion,
    computedAt: now,
    diagnostics: [],
    laneCode: bands.laneCode,
    unit: spec.unit,
    segments: [],
    ladderAssignments: [...spec.bands].sort((a, b) => a.order - b.order).map(o => {
      const mt = matches.find(mm => mm.label === o.label);
      return { ladderPointId: lpId(o.label), bandId: mt?.bandId ?? '', nominalMass: o.mass, s: mt?.s ?? NaN, matched: !!mt };
    }),
    nonMonotonic,
    fitResiduals: []
  };
}
