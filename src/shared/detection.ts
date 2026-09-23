import type {
  DetectedBand,
  DetectionResult,
  Diagnostic,
  LaneAnnotationMaterial,
  LaneGeom,
  LaneProfile,
  PixelPoint,
  PixelProvenance,
} from './types.js';
import type { Raster } from './image.js';
import { sampleCrossSection } from './image.js';
import { arcTable, pointAtArcLength, projectToPolyline } from './geometry.js';
import type { PipelineParams } from './params.js';
import { contentId } from './hash.js';

/**
 * 条带检测（服务端可直接调用）。
 * 沿弯曲泳道中心线建立弧长剖面，再找峰；
 * 饱和（平台）→ saturated；拖尾（不对称）→ tailing；近邻峰 → overlapping。
 */
export function detectBands(
  raster: Raster,
  lanes: LaneAnnotationMaterial,
  imageMaterialId: string,
  params: PipelineParams,
): DetectionResult {
  const p = params.detection;
  const laneProfiles: LaneProfile[] = [];
  const bands: DetectedBand[] = [];
  const diagnostics: Diagnostic[] = [];

  for (const lane of lanes.lanes) {
    const table = arcTable(lane.centerline);
    const total = table[table.length - 1].s;
    const samples: { s: number; intensity: number }[] = [];
    for (let s = 0; s <= Math.round(total); s++) {
      const { point, tangent } = pointAtArcLength(lane.centerline, s);
      samples.push({
        s,
        intensity: sampleCrossSection(raster, point, tangent, p.bandHalfWidthPx, p.lateralHalfWidthPx),
      });
    }
    laneProfiles.push({ laneRef: lane.laneRef, samples: downsample(samples, 400) });

    const signal = samples.map((q) => 255 - q.intensity); // 暗带→正峰
    const peaks = findPeaks(signal, p.minPeakProminence, p.overlapSeparationPx);

    for (const peak of peaks) {
      const s = peak.center;
      const { point, tangent } = pointAtArcLength(lane.centerline, s);
      const center = nearestOnLane(lane, point, tangent);
      const plateauRun = plateauLength(signal, peak.center, p.saturationIntensity, p.plateauMinRunPx);
      const plateau = plateauRun >= p.plateauMinRunPx;
      const tail = tailingAsymmetry(signal, peak);
      const tailing = tail.ratio >= p.tailingAsymmetry;
      const overlappers = peaks.filter((q) => q !== peak && Math.abs(q.center - peak.center) <= p.overlapSeparationPx);
      const overlapGroupId = overlappers.length
        ? [peak, ...overlappers]
            .map((q) => q.center)
            .sort((a, b) => a - b)
            .map((q) => Math.round(q))
            .join('-')
        : null;
      let status: DetectedBand['status'] = 'detected';
      if (overlapGroupId) status = 'overlapping';
      else if (plateau) status = 'saturated';
      else if (tailing) status = 'tailing';

      const rank = peaks.indexOf(peak) + 1;
      const ordinal = Number(lane.laneRef.replace(/^L/, '')) || rank;
      const prov: PixelProvenance = {
        frameId: lanes.frameId,
        materialId: lanes.id,
        point: center,
        contourId: `${lane.laneRef}:profile`,
        method: 'auto_detect',
        note: `arc=${s.toFixed(2)}px`,
      };
      bands.push({
        bandRef: `L${ordinal}-B${rank}`,
        laneRef: lane.laneRef,
        center,
        widthPx: peak.width,
        saturation: plateau ? 1 : Math.max(0, (peak.height - (255 - p.saturationIntensity)) / 40),
        tailing: Math.min(1, tail.ratio / (p.tailingAsymmetry * 1.6)),
        overlapGroupId,
        provenance: prov,
        peakIntensity: Math.round(peak.height),
        plateau,
        status,
        confidence: Math.round((plateau ? 0.5 : tailing ? 0.7 : overlapGroupId ? 0.6 : 0.95) * 100) / 100,
      });
    }
  }

  const resultBase = {
    frameId: lanes.frameId,
    bandMaterialId: null,
    paramsVersion: params.version!,
    parentIds: [imageMaterialId, lanes.id],
    bands,
    laneProfiles,
    diagnostics,
    inputSummary: {
      image: imageMaterialId,
      lanes: lanes.id,
      imageSize: `${raster.width}x${raster.height}px`,
      paramsVersion: params.version,
      laneCount: lanes.lanes.length,
    },
  };
  return { ...resultBase, id: contentId('det', resultBase), kind: 'detection' };
}

function downsample(samples: { s: number; intensity: number }[], maxPoints: number) {
  if (samples.length <= maxPoints) return samples;
  const step = samples.length / maxPoints;
  const out: { s: number; intensity: number }[] = [];
  for (let i = 0; i < maxPoints; i++) out.push(samples[Math.floor(i * step)]);
  return out;
}

interface Peak {
  center: number;
  height: number;
  width: number;
}

/** 找局部极大并按最小分离合并近邻（重叠）。 */
export function findPeaks(signal: number[], minProminence: number, minSeparation: number): Peak[] {
  const peaks: Peak[] = [];
  for (let i = 1; i < signal.length - 1; i++) {
    if (signal[i] >= signal[i - 1] && signal[i] >= signal[i + 1] && signal[i] > signal[i - 1]) {
      const prom = prominence(signal, i);
      if (prom >= minProminence) {
        const w = peakWidth(signal, i);
        peaks.push({ center: i, height: signal[i], width: w });
      }
    }
  }
  // 合并距离过近的峰为重叠组（保留两个中心）
  const merged: Peak[] = [];
  for (const pk of peaks) {
    const near = merged.find((q) => Math.abs(q.center - pk.center) <= minSeparation);
    if (!near) merged.push(pk);
    else {
      // 不合并中心，二者都保留，但宽度扩张以覆盖彼此
      near.width = Math.max(near.width, Math.abs(pk.center - near.center) + pk.width);
      pk.width = near.width;
      merged.push(pk);
    }
  }
  return merged.sort((a, b) => a.center - b.center);
}

function prominence(signal: number[], i: number): number {
  let leftMin = signal[i];
  for (let j = i - 1; j >= 0; j--) {
    if (signal[j] > signal[i]) break;
    leftMin = Math.min(leftMin, signal[j]);
  }
  let rightMin = signal[i];
  for (let j = i + 1; j < signal.length; j++) {
    if (signal[j] > signal[i]) break;
    rightMin = Math.min(rightMin, signal[j]);
  }
  return signal[i] - Math.max(leftMin, rightMin);
}

function peakWidth(signal: number[], i: number): number {
  const half = signal[i] / 2;
  let lo = i;
  let hi = i;
  while (lo > 0 && signal[lo] > half) lo--;
  while (hi < signal.length - 1 && signal[hi] > half) hi++;
  return hi - lo;
}

function plateauLength(signal: number[], center: number, satIntensity: number, _minRun: number): number {
  const level = 255 - satIntensity;
  let run = 1;
  for (let i = center + 1; i < signal.length && signal[i] >= level; i++) run++;
  for (let i = center - 1; i >= 0 && signal[i] >= level; i--) run++;
  return run;
}

function tailingAsymmetry(signal: number[], peak: Peak): { ratio: number } {
  const half = peak.height / 2;
  let front = 0;
  let back = 0;
  for (let i = peak.center; i > 0 && signal[i] > half; i--) front++;
  for (let i = peak.center; i < signal.length - 1 && signal[i] > half; i++) back++;
  return { ratio: back / Math.max(1, front) };
}

function nearestOnLane(lane: LaneGeom, point: PixelPoint, tangent: PixelPoint): PixelPoint {
  // 把检测中心吸附到中心线像素网格，保留像素级坐标。
  const proj = projectToPolyline(lane.centerline, point);
  const { point: snapped } = pointAtArcLength(lane.centerline, proj.s);
  return { x: Math.round(snapped.x * 10) / 10, y: Math.round(snapped.y * 10) / 10, ...(tangent ? {} : {}) };
}

/** 人工修订后的条带：生成新的标注材料（不动旧材料）。 */
export function buildBandAnnotation(
  frameId: string,
  imageId: string,
  input: { bandRef: string; laneRef: string; center: PixelPoint; reason: string }[],
): import('./types.js').BandAnnotationMaterial {
  const bands = input.map((b) => ({
    bandRef: b.bandRef,
    laneRef: b.laneRef,
    center: b.center,
    widthPx: null,
    saturation: 0,
    tailing: 0,
    overlapGroupId: null,
    provenance: {
      frameId,
      materialId: 'manual',
      point: b.center,
      method: 'manual' as const,
      note: b.reason,
    },
  }));
  const base = {
    kind: 'band_annotation' as const,
    imageId,
    frameId,
    bands,
    rawRepresentation: { source: 'reviewer-manual', count: bands.length },
  };
  return { ...base, id: contentId('mat_band', base) };
}
