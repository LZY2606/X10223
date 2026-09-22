import type {
  BandCenterMaterial,
  CalibrationSegment,
  Diagnostic,
  ExposureMaterial,
  GelBundle,
  LadderAssignment,
  LadderMaterial,
  LaneBoundaryMaterial,
  MwCandidate,
  OrientationMaterial,
  RawImageMaterial,
} from '../shared/types';
import { analyzeGel } from './analyze';
import { bandId, candidateId, computeInputDigest, laneId } from './identity';
import { GelFailure, diag } from './errors';
import { sha256Hex } from './digest';
import type { DB } from './db';
import { ProjectStore } from './store';

export interface AnalysisOptions {
  branch?: string;
  ladderLaneOrdinal?: number;
  explicitLadderAssignments?: { bandIndex: number; entryId: string }[];
  paramOverrides?: Record<string, number | string>;
  budgetPixels?: number;
  wallTimeUtcIso?: string;
  logicalClock?: number;
}

/**
 * 自动分析 -> 不可变材料（lane 边界、band 中心，均带像素级来源）+ 派生记录。
 * 所有派生记录携带输入摘要、参数版本、父级依赖。
 */
export function runAutoAnalysis(db: DB, projectId: string, options: AnalysisOptions = {}) {
  const store = new ProjectStore(db, projectId);
  const branch = options.branch ?? 'main';
  const tip = store.tip(branch);
  const image = tip.image;
  const orientation = tip.orientation;
  const exposure = tip.exposure;
  const ladder = tip.ladder;
  if (!image || !orientation || !exposure || !ladder) {
    throw new GelFailure('SEMANTIC_UNRESOLVABLE', [
      diag(
        'INCOMPLETE_INPUT',
        'error',
        '自动分析缺少直接来源：需要原图、拍摄方向、曝光与 ladder 标称值齐备',
        {
          path: !image ? 'image' : !orientation ? 'orientation' : !exposure ? 'exposure' : 'ladder',
          branch,
        }
      ),
    ]);
  }
  const blob = store.getBlob(image.blobUri);
  if (!blob) {
    throw new GelFailure('FORMAT_CORRUPT', [
      diag('FORMAT_CORRUPT', 'error', `图像字节缺失：${image.blobUri}`, { branch }) as Diagnostic,
    ]);
  }

  const result = analyzeGel({
    pngBytes: blob.bytes,
    orientation,
    exposure,
    ladder,
    ladderLaneOrdinal: options.ladderLaneOrdinal,
    explicitLadderAssignments: options.explicitLadderAssignments,
    paramOverrides: options.paramOverrides,
    budgetPixels: options.budgetPixels,
  });

  const basis = {
    imageId: image.imageId,
    origin: 'top-left' as const,
    units: 'px' as const,
    orientationDeg: 0 as const,
  };

  const autoEventOpts = { wallTimeUtcIso: options.wallTimeUtcIso, logicalClock: options.logicalClock };
  const paramVersionKey = 'gel.bandDetection/1.0';
  const laneIds: string[] = [];
  const bandIds: string[] = [];
  const globalRanks: Record<number, number> = {};

  for (const lane of result.lanes) {
    const lid = laneId(lane.ordinal);
    laneIds.push(lid);
    globalRanks[lane.ordinal] = 0;
    const halfWidths = lane.controlPoints.map(() => lane.halfWidthPx);
    const laneMaterial: LaneBoundaryMaterial = {
      kind: 'laneBoundary',
      laneId: lid,
      ordinal: lane.ordinal,
      label: lane.ordinal === (options.ladderLaneOrdinal ?? 0) ? 'L' : `S${lane.ordinal}`,
      isLadderLane: lane.ordinal === (options.ladderLaneOrdinal ?? 0),
      source: 'auto',
      frontTop: { x: lane.frontTop.x, y: lane.frontTop.y, basis },
      frontBottom: { x: lane.frontBottom.x, y: lane.frontBottom.y, basis },
      center: {
        controlPoints: lane.controlPoints.map((p) => ({ x: p.x, y: p.y, basis })),
        halfWidthPx: halfWidths,
      },
      pixelEvidence: {
        boundaryXs: lane.boundaryXs,
        meanIntensity: lane.meanIntensity,
        sampledRows: lane.sampledRows,
      },
    };
    store.addMaterial(branch, laneMaterial, autoEventOpts);

    for (const band of lane.bands) {
      const rank = globalRanks[lane.ordinal]++;
      const bid = bandId(lane.ordinal, rank);
      bandIds.push(bid);
      const overlaps = result.inferences.find(
        (inf) => inf.laneOrdinal === lane.ordinal && inf.bandIndex === rank
      )?.overlappingBandIndices ?? [];
      const bandMaterial: BandCenterMaterial = {
        kind: 'bandCenter',
        bandId: bid,
        laneId: lid,
        center: { x: band.x, y: band.y, basis },
        tArcPx: band.tArcPx,
        source: 'auto',
        widthPx: band.widthPx,
        intensity: {
          peak: band.peak,
          background: band.background,
          area: band.area,
          saturated: band.saturated,
          tailingScore: band.tailingScore,
          tailing: band.tailing,
          saturationFraction: exposure.saturationFraction,
        },
        overlapWith: overlaps.map((idx) => ({
          bandId: bandId(lane.ordinal, idx),
          overlapFraction: 0.5,
        })),
      };
      store.addMaterial(branch, bandMaterial, autoEventOpts);
    }
  }

  const inputDigest = computeInputDigest([
    image.sha256,
    orientation,
    { raw: exposure.rawText, fullScale: exposure.fullScale, fraction: exposure.saturationFraction },
    ladder,
  ]);

  store.append(
    branch,
    'autoAnalyzed',
    { imageId: image.imageId, laneIds, bandIds, paramVersion: paramVersionKey, inputDigest },
    autoEventOpts
  );

  // ladder 分配与局部插值段
  for (const a of result.assignedLadder) {
    const rank = result.lanes
      .find((l) => l.ordinal === (options.ladderLaneOrdinal ?? 0))!
      .bands.indexOf(a.band);
    const assignment: LadderAssignment = {
      assignmentId: `asg-${bandId(options.ladderLaneOrdinal ?? 0, rank)}-${a.entry.entryId}`,
      bandId: bandId(options.ladderLaneOrdinal ?? 0, rank),
      ladderEntryId: a.entry.entryId,
      status: 'assigned',
      segmentId: 'pending',
      residualPx: a.residualPx,
      diagnostics: [],
    };
    store.append(branch, 'derivationEmitted', { kind: 'ladderAssignment', record: assignment }, autoEventOpts);
  }
  for (const segment of result.segments) {
    store.append(
      branch,
      'derivationEmitted',
      { kind: 'calibrationSegment', record: segment satisfies CalibrationSegment },
      autoEventOpts
    );
  }

  // 分子量候选（被采纳/未采纳都保留；区间/歧义状态由证据决定）
  const emitted: MwCandidate[] = [];
  for (const inf of result.inferences) {
    const rank = inf.bandIndex;
    const bid = bandId(inf.laneOrdinal, rank);
    const lid = laneId(inf.laneOrdinal);
    const pv = options.paramOverrides ? 'gel.bandDetection/2.0' : paramVersionKey;
    const cid = candidateId(inputDigest, inf.laneOrdinal, rank, pv);
    const candidate: MwCandidate = {
      candidateId: cid,
      bandId: bid,
      laneId: lid,
      quantity: inf.inference.quantity,
      status: inf.inference.status === 'ambiguous' ? 'ambiguous' : inf.inference.status,
      validRegion: {
        tMinPx: inf.inference.tMinPx,
        tMaxPx: inf.inference.tMaxPx,
        ladderEntryIds: inf.inference.ladderEntryIds,
        segmentId: inf.inference.segmentId,
      },
      interval: inf.inference.interval,
      fitResidualPx: inf.inference.fitResidualPx,
      diagnostics: inf.inference.diagnostics,
      inputDigest,
      parents: [image.imageId, ladder.ladderId, lid, bid, pv],
      paramVersion: pv,
      logicalClock: autoEventOpts.logicalClock ?? 0,
      wallTimeUtcIso: options.wallTimeUtcIso ?? '',
    };
    emitted.push(candidate);
    store.append(branch, 'derivationEmitted', { kind: 'mwCandidate', record: candidate }, autoEventOpts);
  }

  return { store, result, inputDigest, candidates: emitted, diagnostics: result.diagnostics };
}
