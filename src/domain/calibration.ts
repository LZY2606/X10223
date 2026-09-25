import type {
  CalibrationAnchor,
  CalibrationParams,
  LadderMaterial,
  Quantity,
  ValidSegment,
  BandMaterial,
} from '../shared/types.js';
import { PARAMETER_VERSION } from '../shared/types.js';
import { diagnostic } from '../shared/diagnostics.js';
import { interpolate, pointAtS, totalLength } from './geometry.js';

export function defaultParams(): CalibrationParams {
  return {
    parameterVersion: PARAMETER_VERSION,
    model: 'semilog-linear',
    interpolation: 'linear-logm-vs-s',
    extrapolation: 'forbidden',
    monotonicity: 'enforced-strict',
    localScale: 'per-lane',
    saturationThreshold: 250,
    smearBandWidthFactor: 2.4,
    overlapMinSeparationPx: 14,
    missingBandTolerance: 2,
    allowTransferredScale: false,
  };
}

export interface MatchResult {
  anchors: CalibrationAnchor[];
  unmatchedNominal: string[];
  unmatchedBand: string[];
  diagnostics: ReturnType<typeof diagnostic>[];
  nonMonotonic: boolean;
  missingBand: boolean;
}

export function sOfBand(lanePointsLength: number, band: BandMaterial): number {
  void lanePointsLength;
  return band.evidence.sOnLane;
}

export function matchLadder(
  ladder: LadderMaterial,
  bands: BandMaterial[],
  params: CalibrationParams,
): MatchResult {
  const diagnostics: ReturnType<typeof diagnostic>[] = [];
  const laneBands = bands
    .filter((b) => b.laneId === ladder.laneId)
    .sort((a, b) => a.evidence.sOnLane - b.evidence.sOnLane);
  const nominals = [...ladder.nominalBands]
    .filter((n) => !n.missing)
    .sort((a, b) => b.mass.value - a.mass.value);

  const anchors: CalibrationAnchor[] = [];
  const unmatchedNominal: string[] = [];
  const unmatchedBand: string[] = [];

  if (laneBands.length === 0) {
    diagnostics.push(diagnostic('ladder.no-bands', '标尺泳道没有可用条带', 'error', { kind: 'ladder', ladderId: ladder.id }));
    return { anchors, unmatchedNominal: nominals.map((n) => n.id), unmatchedBand, diagnostics, nonMonotonic: false, missingBand: false };
  }

  const tolerance = params.missingBandTolerance ?? 2;
  const missingCount = nominals.length - laneBands.length;
  let offset = 0;
  if (missingCount > tolerance) {
    diagnostics.push(
      diagnostic(
        'ladder.missing-band',
        `标称带 ${nominals.length} 条但仅检出 ${laneBands.length} 条，缺带超过容差 ${tolerance}`,
        'error',
        { kind: 'ladder', ladderId: ladder.id },
        '需要人工指认缺失带或修订标尺',
      ),
    );
    return { anchors, unmatchedNominal: nominals.map((n) => n.id), unmatchedBand: laneBands.map((b) => b.id), diagnostics, nonMonotonic: false, missingBand: true };
  }

  let manual = false;
  for (const nominal of nominals) {
    if (nominal.matchedBandId) {
      const band = laneBands.find((b) => b.id === nominal.matchedBandId);
      if (band) {
        anchors.push(makeAnchor(nominal.id, band.id, band.evidence.sOnLane, nominal.mass));
        manual = true;
      } else {
        unmatchedNominal.push(nominal.id);
      }
    }
  }

  if (!manual) {
    if (missingCount > 0) {
      diagnostics.push(
        diagnostic(
          'ladder.missing-band',
          `标尺疑似缺 ${missingCount} 条带：标称 ${nominals.length} / 检出 ${laneBands.length}`,
          'warning',
          { kind: 'ladder', ladderId: ladder.id },
          '自动对齐按单调序最近匹配，缺带位置标为未决，需人工确认',
        ),
      );
    }
    let j = 0;
    for (let i = 0; i < nominals.length; i++) {
      const nominal = nominals[i]!;
      const remainingNom = nominals.length - i;
      const remainingBand = laneBands.length - j;
      const band = laneBands[j];
      if (band && remainingBand <= remainingNom) {
        anchors.push(makeAnchor(nominal.id, band.id, band.evidence.sOnLane, nominal.mass));
        j++;
      } else if (band) {
        anchors.push(makeAnchor(nominal.id, band.id, band.evidence.sOnLane, nominal.mass));
        j++;
      } else {
        unmatchedNominal.push(nominal.id);
      }
    }
    for (; j < laneBands.length; j++) unmatchedBand.push(laneBands[j]!.id);
  }

  anchors.sort((a, b) => a.s - b.s);
  let nonMonotonic = false;
  for (let i = 1; i < anchors.length; i++) {
    if (anchors[i]!.logMass >= anchors[i - 1]!.logMass) {
      nonMonotonic = true;
      diagnostics.push(
        diagnostic(
          'calibration.non-monotonic',
          `锚点在 s=${anchors[i]!.s} 处不满足迁移距越大分子量越小（log ${anchors[i - 1]!.logMass.toFixed(3)} -> ${anchors[i]!.logMass.toFixed(3)}）`,
          'error',
          { kind: 'ladder', ladderId: ladder.id, nominalBandId: anchors[i]!.nominalBandId },
          '非单调标尺：全局回归无效，仅相邻单调子段可用',
        ),
      );
    }
  }

  return { anchors, unmatchedNominal, unmatchedBand, diagnostics, nonMonotonic, missingBand: missingCount > 0 };
}

function makeAnchor(nominalBandId: string, bandId: string, s: number, mass: Quantity): CalibrationAnchor {
  return { nominalBandId, bandId, s, mass, logMass: Math.log(mass.value), residualLog: 0 };
}

export interface FitResult {
  slope: number;
  intercept: number;
  rSquared: number;
  residuals: CalibrationAnchor[];
}

export function fitSemilogLinear(anchors: CalibrationAnchor[]): FitResult {
  const n = anchors.length;
  if (n < 2) return { slope: 0, intercept: 0, rSquared: 0, residuals: anchors };
  const sx = anchors.reduce((a, p) => a + p.s, 0);
  const sy = anchors.reduce((a, p) => a + p.logMass, 0);
  const sxx = anchors.reduce((a, p) => a + p.s * p.s, 0);
  const sxy = anchors.reduce((a, p) => a + p.s * p.logMass, 0);
  const denom = n * sxx - sx * sx;
  const slope = denom === 0 ? 0 : (n * sxy - sx * sy) / denom;
  const intercept = (sy - slope * sx) / n;
  const meanY = sy / n;
  let ssTot = 0;
  let ssRes = 0;
  const residuals = anchors.map((p) => {
    const fit = intercept + slope * p.s;
    const residual = p.logMass - fit;
    ssTot += (p.logMass - meanY) ** 2;
    ssRes += residual ** 2;
    return { ...p, residualLog: Math.round(residual * 1e6) / 1e6 };
  });
  const rSquared = ssTot === 0 ? 0 : 1 - ssRes / ssTot;
  return { slope, intercept, rSquared, residuals };
}

export function validSegments(anchors: CalibrationAnchor[]): ValidSegment[] {
  if (anchors.length === 0) return [];
  const sorted = [...anchors].sort((a, b) => a.s - b.s);
  const segments: ValidSegment[] = [];
  let start = 0;
  for (let i = 1; i <= sorted.length; i++) {
    const stillDesc = i < sorted.length && sorted[i]!.logMass < sorted[i - 1]!.logMass;
    if (!stillDesc) {
      const part = sorted.slice(start, i);
      if (part.length >= 2) {
        segments.push({
          sMin: part[0]!.s,
          sMax: part[part.length - 1]!.s,
          anchorIds: part.map((p) => p.bandId),
          monotonic: true,
        });
      }
      start = i;
    }
  }
  return segments;
}

export function interpolateMass(
  anchors: CalibrationAnchor[],
  s: number,
): { logMass?: number; segment?: { sMin: number; sMax: number }; anchorIds: string[] } {
  const sorted = [...anchors].sort((a, b) => a.s - b.s);
  const xs = sorted.map((a) => a.s);
  const ys = sorted.map((a) => a.logMass);
  const segs = validSegments(sorted);
  const inside = segs.find((g) => s >= g.sMin && s <= g.sMax);
  const anchorIds = inside ? inside.anchorIds : [];
  if (inside) {
    const logMass = interpolate(xs, ys, s);
    return { logMass, segment: { sMin: inside.sMin, sMax: inside.sMax }, anchorIds };
  }
  return { anchorIds: [] };
}

export function residualsFromFit(anchors: CalibrationAnchor[], fit: FitResult) {
  return anchors.map((a) => ({
    bandId: a.bandId,
    s: a.s,
    logMassObserved: a.logMass,
    logMassFit: Math.round((fit.intercept + fit.slope * a.s) * 1e6) / 1e6,
    residual: a.residualLog,
  }));
}

export function laneEffectiveLength(total: number): { sMin: number; sMax: number } {
  return { sMin: 0, sMax: total };
}

export { pointAtS, totalLength };
