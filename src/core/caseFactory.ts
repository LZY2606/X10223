import type {
  BandObservation,
  LadderRung,
  LaneGeometry,
  WithUnit,
} from '../shared/model.js';
import type { GrayRaster } from './image.js';
import { encodePngGray } from './image.js';
import { sha256Hex } from '../shared/ids.js';
import type { EventLog } from './eventLog.js';
import { appendEvent, createProject, forkBranch } from './service.js';
import { renderSyntheticGel, straightLanes, smilingLanes, type SyntheticBandSpec } from './syntheticGel.js';
import { detectLanes } from './laneDetection.js';
import { detectBandsAlongLane, toObservation, DEFAULT_DETECTION_PARAMETERS } from './detection.js';
import { migrationS } from './geometry.js';
import { resample } from './geomUtil.js';

export const LADDER_BP = [10000, 5000, 3000, 2000, 1500, 1000, 750, 500, 250];
export const LADDER_MISSING_BP = 2000;

export interface BuiltCase {
  log: EventLog;
  raster: GrayRaster;
  png: Buffer;
  blobId: string;
  lanes: LaneGeometry[];
  bands: BandObservation[];
  ladderBp: number[];
  laneXs: number[];
  spec: { width: number; height: number; yTop: number; yBottom: number };
}

export interface BuildCaseOptions {
  smiling?: boolean;
  missingRungBp?: number | null;
  saturated?: boolean;
  overlap?: boolean;
  tailing?: boolean;
  ladderBpOverride?: number[];
  seed?: number;
  variantBandAdjust?: { laneIndex: number; index: number; sFraction: number }[];
}

export function buildGelCase(options: BuildCaseOptions = {}): BuiltCase {
  const width = 640;
  const height = 360;
  const yTop = 34;
  const yBottom = 326;
  const laneXs = [70, 150, 230, 310, 390, 470, 550];
  const halfWidth = 22;
  const lanesSpec = options.smiling
    ? smilingLanes(yTop, yBottom, laneXs, halfWidth, 26)
    : straightLanes(width, yTop, yBottom, laneXs, halfWidth);

  const ladderBp = options.ladderBpOverride ?? LADDER_BP;
  const ladderFractions = ladderFractionsFor(ladderBp);
  const bandSpecs: SyntheticBandSpec[] = [];
  ladderBp.forEach((_, i) => {
    if (options.missingRungBp != null && ladderBp[i] === options.missingRungBp) return;
    bandSpecs.push({
      id: `ladder-${ladderBp[i]}`,
      laneIndex: 0,
      sFraction: ladderFractions[i]!,
      sigmaTangential: halfWidth * 0.5,
      sigmaMigration: 7,
      darkness: 120,
    });
  });

  const sampleFractions = [0.18, 0.31, 0.47, 0.62, 0.78];
  for (let laneIndex = 1; laneIndex < laneXs.length; laneIndex++) {
    sampleFractions.forEach((f, i) => {
      const spec: SyntheticBandSpec = {
        id: `s${laneIndex}-${i}`,
        laneIndex,
        sFraction: f,
        sigmaTangential: halfWidth * 0.5,
        sigmaMigration: 7,
        darkness: 95 - laneIndex * 4,
      };
      if (options.saturated && laneIndex === 2 && i === 2) {
        spec.saturated = true;
        spec.darkness = 150;
      }
      if (options.tailing && laneIndex === 3 && i === 1) {
        spec.tailing = { side: 'down', factor: 2.4 };
      }
      if (options.overlap && laneIndex === 4 && (i === 1 || i === 2)) {
        spec.sFraction = i === 1 ? 0.3 : 0.34;
        spec.sigmaMigration = 5.5;
        spec.darkness = 105;
      }
      bandSpecs.push(spec);
    });
  }
  for (const adjust of options.variantBandAdjust ?? []) {
    const idx = bandSpecs.findIndex(
      (b) => b.laneIndex === adjust.laneIndex && bandSpecs.filter((z) => z.laneIndex === adjust.laneIndex)[adjust.index]?.id === b.id,
    );
    if (idx >= 0) bandSpecs[idx]!.sFraction = adjust.sFraction;
  }

  const raster = renderSyntheticGel({
    width,
    height,
    lanes: lanesSpec,
    bands: bandSpecs,
    seed: options.seed ?? 1194,
    noise: 5,
  });
  const png = encodePngGray(raster);
  const blobId = `blob_gel_${sha256Hex(png).slice(0, 16)}`;
  const lanes = detectLanes(raster, blobId, { halfWidth, searchTop: yTop, searchBottom: yBottom });
  const bands = lanes.flatMap((lane) =>
    detectBandsAlongLane(raster, lane, DEFAULT_DETECTION_PARAMETERS, blobId).map((d) => toObservation(d, blobId)),
  );
  const log = createProject({
    name: '胶道标尺：电泳条带、泳道弯曲与分子量校准工作台',
    description: '离线领域案例：原始凝胶图像的 ladder/lane/band 标注、自动候选与人工修订分子量推断对比',
  });
  return {
    log,
    raster,
    png,
    blobId,
    lanes,
    bands,
    ladderBp,
    laneXs,
    spec: { width, height, yTop, yBottom },
  };
}

export const LADDER_FRACTIONS = [0.115, 0.235, 0.325, 0.405, 0.475, 0.545, 0.615, 0.7, 0.805];

export function ladderFractionsFor(bp: number[]): number[] {
  return bp.map((_, i) => LADDER_FRACTIONS[Math.min(i, LADDER_FRACTIONS.length - 1)]!);
}

export function attachLadderRungs(
  built: BuiltCase,
  branch: string,
  options: { missingBp?: number | null; bpOverride?: number[]; unparseableAt?: number } = {},
): LadderRung[] {
  const ladderLane = built.lanes[0]!;
  const ladderBands = built.bands
    .filter((b) => b.laneId === ladderLane.laneId)
    .sort((a, b) => migrationS(ladderLane, a.center).s - migrationS(ladderLane, b.center).s);
  const bp = options.bpOverride ?? built.ladderBp;
  const rungs: LadderRung[] = bp.map((nominal, i) => {
    const raw = options.unparseableAt === i ? `${nominal}?` : `${nominal} bp`;
    const value: WithUnit<number | null> =
      options.unparseableAt === i
        ? { value: null, unit: 'bp', raw, diagnostic: 'UNPARSEABLE-NOMINAL' }
        : { value: nominal, unit: 'bp', raw };
    return {
      rungId: `rung-${String(i + 1).padStart(2, '0')}`,
      nominalBp: value,
      bandId: null,
      observed: false,
      source: [],
    };
  });
  const missing = options.missingBp ?? null;
  let observedIndex = 0;
  for (const rung of rungs) {
    const nominal = rung.nominalBp.value;
    if (nominal === null) continue;
    if (missing !== null && nominal === missing) continue;
    const band = ladderBands[observedIndex++];
    if (band) {
      rung.bandId = band.bandId;
      rung.observed = true;
      rung.source = [band.source];
    }
  }
  appendEvent(
    { log: built.log, branch, actor: 'system' },
    'ladder-spec-recorded',
    { rungs, ladderLaneId: ladderLane.laneId },
    { deterministic: false, inputSummary: { rungCount: rungs.length, ladderLaneId: ladderLane.laneId } },
  );
  return rungs;
}

export function resampledGeometry(built: BuiltCase): LaneGeometry[] {
  return built.lanes.map((lane) => ({
    ...lane,
    center: resample(lane.center, 4),
    left: resample(lane.left, 4),
    right: resample(lane.right, 4),
  }));
}
