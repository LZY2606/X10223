import type {
  BandAnnotation,
  CalibrationFit,
  GelInput,
  LaneAnnotation,
  MwInference,
} from './types';
import { annotateOverlaps, detectPeaks, laneIntensityProfile, peaksToBands, laneTotalLength, type DetectedPeak } from './detection';
import { buildCalibration } from './calibration';
import { inferBand, mergeOverlapCandidates, validateInput } from './inference';
import { projectToLane } from './geometry';
import { stableId } from '../shared/ids';
import type { Diagnostic } from '../shared/diagnostic';

export interface AnalysisResult {
  lanes: LaneAnnotation[];
  bands: BandAnnotation[];
  fits: CalibrationFit[];
  inferences: MwInference[];
  diagnostics: Diagnostic[];
  profiles: { laneId: string; s: number; intensity: number }[][];
  ok: boolean;
}

/**
 * 完整派生：从不可变材料 + 像素标注出发。
 * lanes/bands 若已提供（人工修订层）则直接使用，否则自动检测。
 */
export function analyze(
  input: GelInput,
  producerEventId = 'manual',
  provided?: { lanes?: LaneAnnotation[]; bands?: BandAnnotation[] },
): AnalysisResult {
  const diagnostics = validateInput(input);
  diagnostics.push(...orientationConsistency(input, provided?.lanes ?? input.lanes));
  const fatal = diagnostics.filter((d) => d.severity === 'error');
  if (fatal.length) {
    return {
      lanes: provided?.lanes ?? input.lanes,
      bands: provided?.bands ?? input.bands,
      fits: [],
      inferences: [],
      diagnostics,
      profiles: [],
      ok: false,
    };
  }

  let lanes = provided?.lanes ?? input.lanes;
  let detectedBands = provided?.bands;
  if (!detectedBands) {
    const all: BandAnnotation[] = [];
    for (const lane of lanes) all.push(...peaksToBands(input.image, lane, producerEventId));
    detectedBands = annotateOverlaps(all);
  } else {
    detectedBands = annotateOverlaps(detectedBands);
  }
  // 回填弧长坐标（人工修订坐标 → 弧长）。
  detectedBands = detectedBands.map((b) => {
    const lane = lanes.find((l) => l.laneId === b.laneId);
    if (!lane) return b;
    const proj = projectToLane(lane, b.center);
    return { ...b, arcLengthPx: Math.round(proj.s * 100) / 100 };
  });

  // ladder 标称值绑定到 ladder 道。
  const ladderLane = lanes.find((l) => l.role === 'ladder') ?? lanes[0]!;
  const fit = buildCalibration(input.ladder, ladderLane, detectedBands);

  const fits: CalibrationFit[] = [fit];
  const fitByLane = new Map<string, CalibrationFit>();
  for (const l of lanes) fitByLane.set(l.laneId, fit);

  const calibrationBroken = fit.diagnostics.some(
    (d) => d.severity === 'error' && d.code === 'non-monotonic-calibration',
  );

  const rawInfs: MwInference[] = [];
  for (const band of detectedBands) {
    if (band.laneId === ladderLane.laneId) continue; // ladder 道不推断样本分子量
    const lane = lanes.find((l) => l.laneId === band.laneId)!;
    if (calibrationBroken) {
      // 标尺本身非单调 → 所有样本带语义无解（不能给唯一解）。
      rawInfs.push(unresolvedCalibration(band, fit, lane));
    } else {
      rawInfs.push(inferBand(band, lane, fit));
    }
  }
  const lanesById = new Map(lanes.map((l) => [l.laneId, l]));
  const inferences = mergeOverlapCandidates(rawInfs, detectedBands, lanesById, fitByLane);

  const profiles = lanes.map((lane) => {
    // 复用检测里的采样
    void laneTotalLength;
    return collectProfile(input, lane);
  });

  const allDiags = [...diagnostics, ...fit.diagnostics, ...inferences.flatMap((i) => i.diagnostics)];
  return {
    lanes,
    bands: detectedBands,
    fits,
    inferences,
    diagnostics: allDiags,
    profiles,
    ok: !allDiags.some((d) => d.severity === 'error'),
  };
}

function collectProfile(input: GelInput, lane: LaneAnnotation) {
  return laneIntensityProfile(input.image, lane).map((p) => ({
    laneId: lane.laneId,
    s: Math.round(p.s * 100) / 100,
    intensity: Math.round(p.intensity),
  }));
}


/**
 * 拍摄方向一致性：沿声明的 ladder 道中心线检测，应找到与 ladder 标称相当数量的峰。
 * 若图像被旋转但方向声明未更新（ladder 道变为横向），沿旧中心线几乎检测不到峰，
 * 返回带位置的 orientation-mismatch 诊断。
 */
function orientationConsistency(input: GelInput, lanes: LaneAnnotation[]): Diagnostic[] {
  const ladderLane = lanes.find((l) => l.role === 'ladder') ?? lanes[0];
  if (!ladderLane) return [];
  const peaks: DetectedPeak[] = detectPeaks(input.image, ladderLane, { minProminence: 18 });
  const provided = input.bands.filter((b) => b.laneId === ladderLane.laneId).length;
  if (provided >= 3 && peaks.length <= 1) {
    const p = ladderLane.centerline.points[0];
    return [
      {
        code: 'orientation-mismatch',
        severity: 'error',
        message: `拍摄方向与图像内容不一致：沿声明 ladder 道仅检测到 ${peaks.length} 个峰（标注有 ${provided} 个），图像疑似被旋转但方向未更新`,
        location: { laneId: ladderLane.laneId, x: p?.x, y: p?.y },
      },
    ];
  }
  return [];
}


function unresolvedCalibration(band: BandAnnotation, fit: CalibrationFit, lane: LaneAnnotation): MwInference {
  const s = projectToLane(lane, band.center).s;
  return {
    inferenceId: stableId('mwinf', band.bandId, fit.fitId, 'infer.v4+calib.v4', 'unresolved'),
    bandId: band.bandId,
    laneId: lane.laneId,
    status: 'unresolved',
    candidates: [],
    diagnostics: [
      {
        code: 'non-monotonic-calibration',
        severity: 'error',
        message: 'ladder 标尺非单调，无法据此推断样本分子量（语义无解）',
        location: { laneId: lane.laneId, bandId: band.bandId, x: band.center.x, y: band.center.y },
      },
    ],
    paramVersion: fit.paramVersion,
    inputSummary: { arcLengthPx: Math.round(s * 100) / 100, validRegion: null },
    parentDepends: [band.bandId, lane.laneId, fit.fitId],
  };
}
