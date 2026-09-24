import type {
  BandCandidateResult,
  CalibrationParams,
  Diagnostic,
  Judgment,
  LaneBoundary,
  LaneProfileResult
} from '../types';
import type { OrientedImage } from '../image/types';
import { BudgetExhaustedError, diag } from '../diagnostic';
import { contentId, digestOf } from '../ids';

export interface BandInput {
  image: OrientedImage;
  boundary: LaneBoundary;
  profileResult: LaneProfileResult;
  params: CalibrationParams;
  parents: string[];
  now: string;
}

interface Peak { i: number; s: number; prom: number; intensity: number }

function findPeaks(p: number[], minProm: number): Peak[] {
  const peaks: Peak[] = [];
  for (let i = 2; i < p.length - 2; i++) {
    if (!(p[i] > p[i - 1] && p[i] >= p[i + 1])) continue;
    let lo = i;
    while (lo > 0 && p[lo - 1] <= p[i]) lo--;
    let hi = i;
    while (hi < p.length - 1 && p[hi + 1] <= p[i]) hi++;
    const base = Math.min(...p.slice(lo, hi + 1));
    const prom = p[i] - base;
    if (prom >= minProm) peaks.push({ i, s: 0, prom, intensity: p[i] });
  }
  return peaks;
}

// 条带检测：候选保留；饱和、拖尾、重叠通过结构化判定限制为候选/区间。
export function detectBands(input: BandInput): {
  result: BandCandidateResult;
  diagnostics: Diagnostic[];
  judgments: Judgment[];
} {
  const { image, boundary, profileResult, params, parents, now } = input;
  const diagnostics: Diagnostic[] = [];
  const judgments: Judgment[] = [];
  const { curve, profile } = profileResult;
  const rawPeaks = findPeaks(profile, params.band.minProminence);

  if (rawPeaks.length > params.budget.maxBandsPerLane) {
    throw new BudgetExhaustedError([
      diag(
        'BAND_BUDGET_EXHAUSTED',
        'budget-exhausted',
        `泳道 ${boundary.laneCode} 检出候选峰 ${rawPeaks.length} 个，超过预算 ${params.budget.maxBandsPerLane}`,
        { laneId: boundary.id, unit: 'dimensionless' }
      )
    ]);
  }

  const half = params.band.bandHalfWidthPx;
  const detected = rawPeaks.map((pk, idx) => {
    const cp = curve[pk.i];
    let satCount = 0, sampleCount = 0, leftSum = 0, rightSum = 0;
    for (let dy = -half; dy <= half; dy++) {
      const j = pk.i + dy;
      if (j < 0 || j >= curve.length) continue;
      const c = curve[j];
      for (let dx = -half; dx <= half; dx++) {
        const xi = Math.round(c.x + dx), yi = Math.round(c.y + dy);
        if (xi < 0 || yi < 0 || xi >= image.width || yi >= image.height) continue;
        const g = image.data[yi * image.width + xi];
        sampleCount++;
        if (g <= 255 - params.band.saturationLevel) satCount++;
        if (dy < 0) leftSum += 255 - g;
        if (dy > 0) rightSum += 255 - g;
      }
    }
    const saturated = satCount / Math.max(1, sampleCount) >= 0.25;
    const asym = Math.abs(leftSum - rightSum) / Math.max(1, leftSum + rightSum);
    const tailing = asym >= params.band.tailRatio;
    const id = contentId('band', {
      lane: boundary.laneCode,
      img: image.parentSha256,
      poly: boundary.polygon,
      x: Number(cp.x.toFixed(2)),
      y: cp.y,
      idx
    });
    return {
      id,
      center: { x: Number(cp.x.toFixed(2)), y: cp.y },
      s: Number(cp.s.toFixed(2)),
      intensity: Math.round(pk.intensity),
      saturated,
      tailing,
      overlapWith: [] as string[],
      evidencePatch: {
        x0: Math.max(0, Math.round(cp.x - half)),
        y0: Math.max(0, cp.y - half),
        x1: Math.min(image.width - 1, Math.round(cp.x + half)),
        y1: Math.min(image.height - 1, cp.y + half)
      },
      judgmentCodes: [] as string[],
      _leftSum: leftSum,
      _rightSum: rightSum
    };
  });

  // 重叠：弧长方向间距过小的两条带
  for (let i = 0; i < detected.length; i++) {
    for (let j = i + 1; j < detected.length; j++) {
      if (Math.abs(detected[i].s - detected[j].s) <= params.band.overlapCenterDeltaPx) {
        detected[i].overlapWith.push(detected[j].id);
        detected[j].overlapWith.push(detected[i].id);
      }
    }
  }

  for (const b of detected) {
    if (b.saturated) {
      b.judgmentCodes.push('SATURATED_BAND_CANDIDATE_ONLY');
      judgments.push({
        code: 'SATURATED_BAND_CANDIDATE_ONLY',
        message: '饱和条带中心不可信，只能作为候选',
        severity: 'warning',
        evidence: { bandId: b.id, saturationLevel: params.band.saturationLevel, patch: b.evidencePatch },
        affectedObjectIds: [b.id]
      });
    }
    if (b.tailing) {
      b.judgmentCodes.push('TAILING_BAND_CANDIDATE_ONLY');
      judgments.push({
        code: 'TAILING_BAND_CANDIDATE_ONLY',
        message: '拖尾条带中心偏移不可唯一确定，只能作为候选',
        severity: 'warning',
        evidence: { bandId: b.id, asymmetry: Math.abs(b._leftSum - b._rightSum) / Math.max(1, b._leftSum + b._rightSum) },
        affectedObjectIds: [b.id]
      });
    }
    if (b.overlapWith.length) {
      b.judgmentCodes.push('OVERLAPPING_BANDS_INTERVAL_OR_CANDIDATES');
      judgments.push({
        code: 'OVERLAPPING_BANDS_INTERVAL_OR_CANDIDATES',
        message: '两条带重叠，只能给出区间或全部合法候选',
        severity: 'warning',
        evidence: { bandId: b.id, overlapWith: b.overlapWith },
        affectedObjectIds: [b.id, ...b.overlapWith]
      });
    }
  }

  const clean = detected.map(({ _leftSum, _rightSum, ...rest }) => rest);
  const id = contentId('bands', {
    lane: boundary.laneCode,
    profile: profileResult.id,
    bands: clean.map(b => [b.center.x, b.center.y, b.intensity]),
    pv: params.paramVersion
  });
  const result: BandCandidateResult = {
    id,
    type: 'band-candidates',
    parentIds: parents,
    inputDigest: digestOf({ profile: profileResult.id, img: image.parentSha256, pv: params.paramVersion }),
    paramVersion: params.paramVersion,
    computedAt: now,
    diagnostics,
    laneCode: boundary.laneCode,
    bands: clean
  };
  return { result, diagnostics, judgments };
}
