/**
 * 自动候选检测：沿 lane 中心线（弧长基准）提取一维轮廓、找峰并分类。
 * 这些结果全部是“候选”，并带方法/参数版本来源；人工接受/拒绝/调整只追加决定。
 */
import { cumulativeLengths, projectToCurve } from './geometry';
import { sampleProfile } from './imageOps';
import type {
  BandMark,
  BandMarksMaterial,
  ExposureMaterial,
  LaneMapMaterial,
  OrientationMaterial,
  RuleParams,
  SourcedPoint
} from './types';
import { BUDGETS } from './types';
import { ResourceBudgetError } from './diagnostics';
import { hashJson, shortId } from './hash';
import type { Raster } from './png';
import { toGray } from './png';

export interface DetectedPeak {
  laneIndex: number;
  s: number;
  centerCanonical: { x: number; y: number };
  peakIntensity: number;
  fwhm: number;
  saturated: boolean;
  smear: boolean;
}

export interface DetectionResult {
  peaks: DetectedPeak[];
  profiles: Record<number, { s: number[]; intensity: number[] }>;
}

/** 预算先于一切：超出预算必须是 RESOURCE_BUDGET（区别于格式损坏/语义无解）。 */
export function assertRasterBudget(raster: Raster): void {
  if (raster.width * raster.height > BUDGETS.maxPixels) {
    throw new ResourceBudgetError('RESOURCE_BUDGET', `像素数超过预算: ${raster.width * raster.height} > ${BUDGETS.maxPixels}`);
  }
}

export function detectPeaks(
  raster: Raster,
  laneMap: LaneMapMaterial,
  orientation: OrientationMaterial,
  exposure: ExposureMaterial,
  params: RuleParams
): DetectionResult {
  assertRasterBudget(raster);
  if (laneMap.lanes.length > BUDGETS.maxLanes) {
    throw new ResourceBudgetError('RESOURCE_BUDGET', `泳道数超过预算 ${BUDGETS.maxLanes}`);
  }
  const gray = toGray(raster);
  const peaks: DetectedPeak[] = [];
  const profiles: DetectionResult['profiles'] = {};

  for (const lane of laneMap.lanes) {
    const poly = lane.centerline.map((p) => ({ x: p.x, y: p.y }));
    const halfWidth = Math.max(
      4,
      Math.round(
        (projectToCurve(lane.leftBoundary[0] ?? lane.centerline[0]!, poly).dist +
          projectToCurve(lane.rightBoundary[0] ?? lane.centerline[0]!, poly).dist) / 2
      )
    );
    const { s, intensity } = sampleProfile(gray, raster.width, raster.height, poly, halfWidth);
    profiles[lane.laneIndex] = { s, intensity };
    const lanePeaks = findPeaks(s, intensity, params, exposure, poly, lane.laneIndex);
    if (lanePeaks.length > BUDGETS.maxBandsPerLane) {
      throw new ResourceBudgetError(
        'RESOURCE_BUDGET',
        `泳道 ${lane.laneIndex} 条带数超过预算 ${BUDGETS.maxBandsPerLane}`
      );
    }
    peaks.push(...lanePeaks);
  }
  return { peaks, profiles };
}

function pointAt(curve: { x: number; y: number }[], targetS: number): { x: number; y: number } {
  let acc = 0;
  for (let i = 0; i < curve.length - 1; i++) {
    const a = curve[i]!;
    const b = curve[i + 1]!;
    const segLen = Math.hypot(b.x - a.x, b.y - a.y);
    if (acc + segLen >= targetS) {
      const t = (targetS - acc) / (segLen || 1);
      return { x: a.x + t * (b.x - a.x), y: a.y + t * (b.y - a.y) };
    }
    acc += segLen;
  }
  return curve[curve.length - 1]!;
}

function findPeaks(
  s: number[],
  intensity: number[],
  params: RuleParams,
  exposure: ExposureMaterial,
  poly: { x: number; y: number }[],
  laneIndex: number
): DetectedPeak[] {
  const n = s.length;
  if (n < 5) return [];
  const smooth = movingAverage(intensity, 3);
  const baseline = percentile(smooth, 20);
  const noise = mad(smooth.map((v, i) => v - baseline));
  const threshold = baseline + Math.max(6, noise * 4);
  const peaks: DetectedPeak[] = [];

  for (let i = 2; i < n - 2; i++) {
    if (smooth[i]! >= smooth[i - 1]! && smooth[i]! >= smooth[i + 1]! && smooth[i]! > threshold) {
      if (peaks.length === 0 || s[i]! - peaks[peaks.length - 1]!.s > 4) {
        const fwhm = measureFwhm(s, smooth, i);
        const center = pointAt(poly, s[i]!);
        peaks.push({
          laneIndex,
          s: s[i]!,
          centerCanonical: center,
          peakIntensity: Math.round(smooth[i]!),
          fwhm,
          saturated: smooth[i]! >= params.saturationThreshold || smooth[i]! >= exposure.intensityCeiling - 1,
          smear: fwhm > params.smearWidthRatio * medianFwhmPlaceholder()
        });
      }
    }
  }
  const widths = peaks.map((p) => p.fwhm).sort((a, b) => a - b);
  const medianWidth = widths.length ? widths[Math.floor(widths.length / 2)]! : 8;
  for (const p of peaks) p.smear = p.fwhm > params.smearWidthRatio * medianWidth;

  for (let i = 0; i < peaks.length; i++) {
    for (let j = i + 1; j < peaks.length; j++) {
      if (peaks[j]!.s - peaks[i]!.s < params.overlapDistancePx) {
        // 重叠由校准层枚举区间，这里只做峰级标记（fwhm 合并表现为加宽）。
      }
    }
  }
  return peaks;
}

function medianFwhmPlaceholder(): number {
  return 8;
}

function measureFwhm(s: number[], v: number[], idx: number): number {
  const half = (v[idx]! + percentile(v, 20)) / 2;
  let lo = idx;
  let hi = idx;
  while (lo > 0 && v[lo]! > half) lo--;
  while (hi < v.length - 1 && v[hi]! > half) hi++;
  return s[hi]! - s[lo]!;
}

function movingAverage(v: number[], w: number): number[] {
  const out = new Array<number>(v.length);
  const half = Math.floor(w / 2);
  for (let i = 0; i < v.length; i++) {
    let acc = 0;
    let n = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(v.length - 1, i + half); j++) {
      acc += v[j]!;
      n++;
    }
    out[i] = acc / n;
  }
  return out;
}

function percentile(v: number[], p: number): number {
  const sorted = [...v].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.floor((p / 100) * sorted.length))]!;
}

function mad(v: number[]): number {
  const med = percentile(v, 50);
  return percentile(
    v.map((x) => Math.abs(x - med)),
    50
  );
}

/** 检测候选 -> 带像素级来源的 bandMarks 材料（auto 候选层）。 */
export function peaksToBandMarksMaterial(
  imageId: string,
  materialBaseId: string,
  detection: DetectionResult,
  paramsHash: string,
  rulesVersion: string
): BandMarksMaterial {
  const bands: BandMark[] = detection.peaks.map((peak) => {
    const center: SourcedPoint = {
      x: peak.centerCanonical.x,
      y: peak.centerCanonical.y,
      frame: 'canonical',
      source: {
        materialId: materialBaseId,
        origin: 'auto',
        method: 'profile-peak',
        raw: `s=${peak.s.toFixed(3)}px`,
        basedOn: [paramsHash, rulesVersion]
      }
    };
    const id = shortId(
      hashJson({ lane: peak.laneIndex, x: center.x, y: center.y, image: imageId, origin: 'auto' }),
      'bm'
    );
    return {
      id,
      laneIndex: peak.laneIndex,
      center,
      rawCenter: { ...center },
      arcLength: peak.s,
      peakIntensity: peak.peakIntensity,
      saturated: peak.saturated,
      widthPx: peak.fwhm,
      smear: peak.smear,
      provenance: { materialId: materialBaseId, origin: 'auto', method: 'detectPeaks', basedOn: [paramsHash, rulesVersion] }
    };
  });
  return {
    kind: 'bandMarks',
    id: shortId(hashJson({ imageId, bands: bands.map((b) => b.id) }), 'bmarks'),
    imageId,
    bands,
    provenance: { materialId: materialBaseId, origin: 'auto', method: 'detectPeaks', basedOn: [paramsHash] }
  };
}
