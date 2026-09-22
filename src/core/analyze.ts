import type { Diagnostic, ExposureMaterial, LadderMaterial, OrientationMaterial } from '../shared/types';
import { decodePng, type RawImage } from './png';
import { rotateCW } from './geometry';
import { Budget, detectLanes } from './detect';
import { detectBands, type DetectedBand } from './bands';
import { assignLadder, fitSegments, inferMw, type AssignedLadderBand } from './calibration';
import { GelFailure, diag } from './errors';
import { PARAM_VERSIONS } from './params';

export const DEFAULT_PIXEL_BUDGET = 8_000_000;

export interface AnalyzeInput {
  /** 原始编码字节（导入时保留的原始表示） */
  pngBytes: Buffer;
  /** 原图尺寸预期（可选，用于资源预算前置判断） */
  orientation: OrientationMaterial;
  exposure: ExposureMaterial;
  ladder: LadderMaterial;
  ladderLaneOrdinal?: number;
  explicitLadderAssignments?: { bandIndex: number; entryId: string }[];
  paramOverrides?: Record<string, number | string>;
  budgetPixels?: number;
}

export interface AnalyzedLane {
  ordinal: number;
  controlPoints: { x: number; y: number }[];
  halfWidthPx: number;
  frontTop: { x: number; y: number };
  frontBottom: { x: number; y: number };
  poly: { x: number; y: number }[];
  table: number[];
  meanIntensity: number;
  boundaryXs: number[];
  sampledRows: number;
  bands: DetectedBand[];
}

export interface AnalyzeResult {
  /** 归一化（方向校正后）的光栅，检测全部在此帧进行 */
  normalized: RawImage;
  /** 方向校正所施加的顺时针旋转 */
  normalizationDeg: 0 | 90 | 180 | 270;
  lanes: AnalyzedLane[];
  assignedLadder: AssignedLadderBand[];
  segments: ReturnType<typeof fitSegments>['segments'];
  /** laneOrdinal -> 该 lane 内推断结果（band 顺序与 bands 一致） */
  inferences: {
    laneOrdinal: number;
    bandIndex: number;
    inference: ReturnType<typeof inferMw>;
    overlappingBandIndices: number[];
  }[];
  diagnostics: Diagnostic[];
  paramVersions: string[];
}

/**
 * 业务规则入口：服务端与存储测试直接调用，不依赖浏览器。
 * 三类失败在此分流：FORMAT_CORRUPT（字节/PNG 层）、
 * RESOURCE_BUDGET_EXHAUSTED（预算）、SEMANTIC_UNRESOLVABLE（语义无解）。
 */
export function analyzeGel(input: AnalyzeInput): AnalyzeResult {
  let raw: RawImage;
  try {
    raw = decodePng(input.pngBytes);
  } catch (err) {
    if ((err as Error).name === 'FormatCorruptError') {
      throw new GelFailure('FORMAT_CORRUPT', [
        diag('FORMAT_CORRUPT', 'error', (err as Error).message, {}),
      ]);
    }
    throw err;
  }

  if (!raw.width || !raw.height || raw.data.length !== raw.width * raw.height * raw.channels) {
    throw new GelFailure('FORMAT_CORRUPT', [
      diag('FORMAT_CORRUPT', 'error', '图像维度与像素字节数不一致', {}),
    ]);
  }

  // 预算前置判定：资源耗尽必须是独立结果
  const budget: Budget = { pixels: input.budgetPixels ?? DEFAULT_PIXEL_BUDGET, used: 0 };
  if (raw.width * raw.height > budget.pixels) {
    throw new GelFailure('RESOURCE_BUDGET_EXHAUSTED', [
      diag(
        'RESOURCE_BUDGET_EXHAUSTED',
        'error',
        `图像 ${raw.width}x${raw.height}=${raw.width * raw.height} 像素超过预算 ${budget.pixels}`,
        {}
      ),
    ]);
  }

  if (!input.exposure?.fullScale) {
    throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
      diag('INCOMPLETE_INPUT', 'error', '缺少曝光满量程，无法定义饱和判据', { path: 'exposure.fullScale' }),
    ]);
  }
  if (!input.ladder?.entries?.length) {
    throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
      diag('INCOMPLETE_INPUT', 'error', '缺少 ladder 标称值，无法建立分子量标尺', { path: 'ladder.entries' }),
    ]);
  }
  const badEntry = input.ladder.entries.find((e) => e.nominal.diagnostic?.severity === 'error');
  if (badEntry) {
    throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
      { ...badEntry.nominal.diagnostic!, position: { ...badEntry.nominal.diagnostic!.position, ladderEntryId: badEntry.entryId } },
    ]);
  }
  if (![0, 90, 180, 270].includes(input.orientation.upDegrees)) {
    throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
      diag('ROTATION_UNKNOWN', 'error', `拍摄方向 ${input.orientation.upDegrees}° 不是离散合法值，拒绝猜测`, {}),
    ]);
  }

  // 方向归一化：把“朝上”旋回 0
  const normDeg = ((360 - input.orientation.upDegrees) % 360) as 0 | 90 | 180 | 270;
  const normalized: RawImage =
    normDeg === 0
      ? raw
      : (() => {
          const r = rotateCW(raw, normDeg);
          return { width: r.width, height: r.height, channels: raw.channels, data: r.data };
        })();

  const diagnostics: Diagnostic[] = [];
  if (normDeg !== 0) {
    diagnostics.push(
      diag('ROTATION_UNKNOWN', 'info', `按拍摄方向材料顺时针校正 ${normDeg}° 后检测，像素来源保留原图像版本`, {})
    );
  }

  const detected = detectLanes(normalized, budget);
  if (detected.length === 0) {
    throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
      diag('INCOMPLETE_INPUT', 'error', '未检测到任何泳道，lane 边界证据为空', {}),
    ]);
  }

  const satFraction = input.exposure.saturationFraction;
  const lanes: AnalyzedLane[] = detected.map((dl) => {
    const bands = detectBands(normalized, dl, budget, input.exposure.fullScale, satFraction, input.paramOverrides);
    const front = dl.poly[0];
    const end = dl.poly[dl.poly.length - 1];
    return {
      ordinal: dl.ordinal,
      controlPoints: dl.controlPoints,
      halfWidthPx: dl.halfWidthPx,
      frontTop: { x: front.x, y: front.y },
      frontBottom: { x: end.x, y: end.y },
      poly: dl.poly,
      table: dl.table,
      meanIntensity: dl.meanIntensity,
      boundaryXs: dl.boundaryXs,
      sampledRows: dl.sampledRows,
      bands,
    };
  });

  const ladderOrdinal = input.ladderLaneOrdinal ?? 0;
  const ladderLane = lanes.find((l) => l.ordinal === ladderOrdinal);
  if (!ladderLane) {
    throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
      diag('INCOMPLETE_INPUT', 'error', `ladder 泳道序号 ${ladderOrdinal} 不存在`, { laneId: `lane-${ladderOrdinal + 1}` }),
    ]);
  }

  const { assigned, diagnostics: assignDiag } = assignLadder(
    ladderLane.bands,
    input.ladder.entries,
    input.explicitLadderAssignments
  );
  diagnostics.push(...assignDiag);

  const laneId = `lane-${ladderOrdinal + 1}`;
  const { segments, diagnostics: segDiag } = fitSegments(laneId, assigned);
  diagnostics.push(...segDiag);

  const entryById = new Map(input.ladder.entries.map((e) => [e.entryId, e]));
  const inferences: AnalyzeResult['inferences'] = [];
  for (const lane of lanes) {
    if (lane.ordinal === ladderOrdinal) continue;
    for (let bi = 0; bi < lane.bands.length; bi++) {
      const band = lane.bands[bi];
      const overlappingBandIndices = lane.bands
        .map((b, idx) => ({ b, idx }))
        .filter(({ b, idx }) => idx !== bi && Math.abs(b.tArcPx - band.tArcPx) < (b.widthPx + band.widthPx) / 2)
        .map(({ idx }) => idx);
      const inference = inferMw(band, segments, entryById, {
        saturated: band.saturated,
        tailing: band.tailing,
        overlapping: overlappingBandIndices.length > 0,
      });
      // 传递检测阶段的像素证据诊断
      inference.diagnostics = [...band.diagnostics, ...inference.diagnostics];
      inferences.push({ laneOrdinal: lane.ordinal, bandIndex: bi, inference, overlappingBandIndices });
    }
  }

  return {
    normalized,
    normalizationDeg: normDeg,
    lanes,
    assignedLadder: assigned,
    segments,
    inferences,
    diagnostics,
    paramVersions: [
      PARAM_VERSIONS.laneDetection,
      PARAM_VERSIONS.bandDetection,
      PARAM_VERSIONS.calibration,
      PARAM_VERSIONS.saturation,
    ],
  };
}
