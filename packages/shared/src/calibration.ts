import { stableDigest } from './hash.js';
import { projectToPolyline } from './geometry.js';
import type {
  BandObservationMaterial,
  CalibrationResult,
  CalibrationSegment,
  Diagnostic,
  LadderMaterial,
  LaneSketchMaterial,
  LadderPointResult,
  DomainValue
} from './types.js';

export interface CalibrationParams {
  model: 'piecewise-linear-log';
  validPaddingPx: number;
  maxMatchTolerancePx: number;
}

export const DEFAULT_CALIBRATION_PARAMS: CalibrationParams = {
  model: 'piecewise-linear-log',
  validPaddingPx: 6,
  maxMatchTolerancePx: 48
};

interface LadderAnchor {
  nominal: DomainValue;
  band: BandObservationMaterial;
  s: number;
  ladderBandId: string;
  observed: boolean;
}

/** 把 ladder 标称值与 lane 上检测到的条带做单调对齐；允许缺带（跳过 ladder 条）。
 *  动态规划：在“非单调标尺”时显式失败并给位置，而不是悄悄交换。 */
function alignLadder(
  ladder: LadderMaterial,
  bands: BandObservationMaterial[],
  lane: LaneSketchMaterial,
  params: CalibrationParams
): { anchors: LadderAnchor[]; points: LadderPointResult[]; diagnostics: Diagnostic[] } {
  const diagnostics: Diagnostic[] = [];
  const sortedBands = [...bands].sort((a, b) => arc(a, lane) - arc(b, lane));
  const nominals = ladder.bands
    .map((b, i) => ({ b, i, v: b.nominal.value, sExpected: b.expectedPoint ? projectToPolyline(b.expectedPoint, lane.centerline).arcLength : null }))
    .sort((x, y) => (y.v ?? -Infinity) - (x.v ?? -Infinity));

  // 不可转换标称值 -> 语义无解，留在原位置。
  for (const n of nominals) {
    if (n.v === null || n.v <= 0) {
      diagnostics.push({
        code: 'SEMANTIC_UNRESOLVABLE',
        severity: 'error',
        message: `ladder 条 ${n.i} 标称值 "${n.b.nominal.raw}" 无法参与对数校准`,
        location: { materialId: ladder.id, field: `bands[${n.i}].nominal` }
      });
    }
  }
  if (diagnostics.some((d) => d.severity === 'error')) {
    return {
      anchors: [],
      points: ladder.bands.map((b) => ({
        ladderBandId: `ladderband-${ladder.id}-${stableDigest(b.nominal.raw).slice(0, 8)}`,
        nominal: b.nominal,
        matchedBandId: null,
        point: b.expectedPoint ?? sortedBands[0]?.center ?? { x: 0, y: 0, ref: { frameId: lane.imageId, frameKind: 'raw-image', unit: 'pixel' } },
        arcLength: b.expectedPoint ? projectToPolyline(b.expectedPoint, lane.centerline).arcLength : 0,
        residual: null,
        used: false,
        diagnostic: b.nominal.diagnostic
      })),
      diagnostics
    };
  }

  // DP：行=按分子量排序的 ladder 条，列=检测到的 band。
  const N = nominals.length;
  const M = sortedBands.length;
  const cost: number[][] = Array.from({ length: N + 1 }, () => new Array<number>(M + 1).fill(Infinity));
  const choice: number[][] = Array.from({ length: N + 1 }, () => new Array<number>(M + 1).fill(-1));
  cost[0] = new Array(M + 1).fill(0);
  for (let i = 1; i <= N; i++) {
    for (let j = 1; j <= M; j++) {
      // skip ladder band (missing band) with penalty
      const skip = cost[i - 1]![j]! + 0.5;
      // skip observed band
      const skipBand = cost[i]![j - 1]! + 0.8;
      const band = sortedBands[j - 1]!;
      const s = arc(band, lane);
      const expect = nominals[i - 1]!.sExpected;
      let pairCost = 1;
      if (expect !== null) pairCost += Math.min(10, Math.abs(s - expect) / 6);
      if (band.saturated) pairCost += 0.2;
      // 单调约束：前一个匹配 band 必须弧长更小
      let monotone = true;
      for (let k = j - 2; k >= 0; k--) {
        const pair = findPair(choice, i - 1, j - 1);
        if (pair >= 0) {
          if (!(arc(sortedBands[pair]!, lane) < s)) monotone = false;
          break;
        }
      }
      const pair = monotone ? cost[i - 1]![j - 1]! + pairCost : Infinity;
      const best = Math.min(skip, skipBand, pair);
      cost[i]![j] = best;
      choice[i]![j] = best === skip ? 0 : best === skipBand ? 1 : 2;
    }
  }
  const matched = new Map<number, number>();
  let i = N;
  let j = M;
  while (i > 0 && j > 0) {
    const c = choice[i]![j];
    if (c === 2) {
      matched.set(i - 1, j - 1);
      i--; j--;
    } else if (c === 0) {
      i--;
    } else {
      j--;
    }
  }

  const points: LadderPointResult[] = [];
  const anchors: LadderAnchor[] = [];
  for (let li = 0; li < nominals.length; li++) {
    const n = nominals[li]!;
    const id = `ladderband-${ladder.id}-${stableDigest(n.b.nominal.raw).slice(0, 8)}`;
    const matchedBandIdx = matched.get(li);
    if (matchedBandIdx === undefined) {
      points.push({
        ladderBandId: id,
        nominal: n.b.nominal,
        matchedBandId: null,
        point: n.b.expectedPoint ?? { x: -1, y: -1, ref: { frameId: lane.imageId, frameKind: 'raw-image', unit: 'pixel' } },
        arcLength: n.sExpected ?? -1,
        residual: null,
        used: false,
        diagnostic: {
          code: 'LADDER_MISSING_BAND',
          severity: n.b.observed ? 'warning' : 'info',
          message: `标称 ${n.b.nominal.raw} 在 ladder lane 未匹配到可见条带（缺带），不参与该区间插值`,
          location: { materialId: ladder.id, point: n.b.expectedPoint ?? undefined }
        }
      });
      continue;
    }
    const band = sortedBands[matchedBandIdx]!;
    const s = arc(band, lane);
    anchors.push({ nominal: n.b.nominal, band, s, ladderBandId: id, observed: n.b.observed });
    points.push({
      ladderBandId: id,
      nominal: n.b.nominal,
      matchedBandId: band.id,
      point: band.center,
      arcLength: s,
      residual: null,
      used: true
    });
  }

  // 非单调标尺检测：弧长增大时分子量没有严格减小 => 标尺非法
  const used = anchors.sort((a, b) => a.s - b.s);
  for (let k = 1; k < used.length; k++) {
    if (used[k]!.nominal.value! >= used[k - 1]!.nominal.value!) {
      diagnostics.push({
        code: 'NON_MONOTONIC_SCALE',
        severity: 'error',
        message: `非单调标尺：s=${used[k]!.s.toFixed(1)}px 处 ${used[k]!.nominal.raw} 未小于 s=${used[k - 1]!.s.toFixed(1)}px 处 ${used[k - 1]!.nominal.raw}；标尺不可用`,
        location: { materialId: ladder.id, point: used[k]!.band.center }
      });
      points.forEach((p) => {
        if (p.ladderBandId === used[k]!.ladderBandId) p.used = false;
      });
    }
  }

  return { anchors, points, diagnostics };
}

function findPair(choice: number[][], i: number, j: number): number {
  while (i > 0 && j > 0) {
    const c = choice[i]![j];
    if (c === 2) return j - 1;
    if (c === 0) i--;
    else j--;
  }
  return -1;
}

function arc(band: BandObservationMaterial, lane: LaneSketchMaterial): number {
  if (band.arcLength?.value !== null && band.arcLength?.value !== undefined) return band.arcLength.value;
  return projectToPolyline(band.center, lane.centerline).arcLength;
}

export function calibrateLadder(
  ladder: LadderMaterial,
  bands: BandObservationMaterial[],
  lane: LaneSketchMaterial,
  params: CalibrationParams
): CalibrationResult {
  const { anchors, points, diagnostics } = alignLadder(ladder, bands, lane, params);
  const nonMonotonic = diagnostics.some((d) => d.code === 'NON_MONOTONIC_SCALE');
  const segments: CalibrationSegment[] = [];
  const used = anchors
    .filter((a) => !(nonMonotonic && false))
    .sort((a, b) => a.s - b.s);

  if (!nonMonotonic && used.length >= 2) {
    for (let k = 1; k < used.length; k++) {
      const lo = used[k - 1]!;
      const hi = used[k]!;
      const y1 = Math.log10(lo.nominal.value!);
      const y2 = Math.log10(hi.nominal.value!);
      const slope = (y2 - y1) / (hi.s - lo.s);
      const intercept = y1 - slope * lo.s;
      segments.push({
        id: `seg-${lo.ladderBandId}-${hi.ladderBandId}`,
        fromLadderBandId: lo.ladderBandId,
        toLadderBandId: hi.ladderBandId,
        validS: [lo.s - params.validPaddingPx, hi.s + params.validPaddingPx],
        model: 'linear-log',
        slope,
        intercept
      });
    }
    // 残差：相对分段模型
    for (const p of points) {
      const a = used.find((u) => u.ladderBandId === p.ladderBandId);
      if (!a) continue;
      const seg = segments.find((sg) => p.arcLength >= sg.validS[0] && p.arcLength <= sg.validS[1]);
      if (seg) {
        const predicted = Math.pow(10, seg.slope * p.arcLength + seg.intercept);
        p.residual = Math.log10(a.nominal.value!) - (seg.slope * p.arcLength + seg.intercept);
        void predicted;
      }
    }
  }

  const sValues = used.map((a) => a.s);
  const validRegion = {
    laneId: lane.id,
    s: sValues.length ? [Math.min(...sValues) - params.validPaddingPx, Math.max(...sValues) + params.validPaddingPx] : [0, 0],
    note: '局部标尺有效区域：仅在本 lane 弧长区间内可用；微笑弯曲下跨 lane 的同一像素高度不等于同一分子量'
  };

  if (used.length < 2 && !nonMonotonic) {
    diagnostics.push({
      code: 'LADDER_MISSING_BAND',
      severity: 'error',
      message: '可匹配 ladder 点不足 2 个，无法建立分段标尺',
      location: { materialId: ladder.id }
    });
  }

  return {
    laneId: lane.id,
    model: 'piecewise-linear-log',
    points: points.sort((a, b) => a.arcLength - b.arcLength),
    segments,
    validRegion,
    monotonic: !nonMonotonic,
    diagnostics
  };
}

export function segmentIdDigest(laneId: string, sRounded: number): string {
  return `mw-${laneId}-${stableDigest({ laneId, s: sRounded }).slice(0, 10)}`;
}
