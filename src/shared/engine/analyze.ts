import type {
  AnalysisResult,
  BandCandidate,
  BandObservation,
  DetectedLane,
  Diag,
  ImageMaterial,
  InputSummary,
  LadderMaterial,
  LaneObservation,
  MwCandidate,
  MwInference,
  ParamSet,
  PixelPoint,
} from '../types.js';
import type { GrayImage } from '../png.js';
import { contentId, sha256Hex, sortById, stableStringify } from '../hash.js';
import { curveMetric, projectToCurve } from '../geometry.js';
import { detectLanes } from './detectLanes.js';
import { detectBands, type RawBand } from './detectBands.js';
import { buildCalibration } from './calibration.js';
import { BudgetExhaustedError, IncompleteInputError } from './errors.js';
import { makeQuantity } from '../units.js';

export const ENGINE_VERSION = 'gel-engine-1.0.0';

export interface AnalyzeInput {
  image: ImageMaterial;
  /** 已转正灰度图（原始图 + 拍摄方向的派生，像素来源在 observations 中保留 shotPoint） */
  upright: GrayImage;
  /** 原始拍摄帧灰度（用于把每个观测点写回 shot 像素） */
  shot: GrayImage;
  ladder: LadderMaterial | null;
  params: ParamSet;
  /** 产生本次分析的事件 id（写入 provenance 与派生身份） */
  eventId: string;
  /** 显式停用的 ladder 标称带（缺带） */
  disabledLadderBands?: Set<string>;
  /** 修订模式：直接提供泳道/条带观测（自动模式可为 null） */
  laneOverrides?: LaneObservation[];
  bandOverrides?: BandObservation[];
  /** 父级派生结果 id（记录依赖） */
  parentResultIds?: string[];
  shotWidth: number;
  shotHeight: number;
}

function inputSummaryOf(input: AnalyzeInput, obsHash: string, parents: string[]): InputSummary {
  return {
    engineVersion: ENGINE_VERSION,
    imageSha256: input.image.blobSha256,
    ladderId: input.ladder?.id,
    observationSetHash: obsHash,
    paramSetId: input.params.id,
    parentResultIds: parents,
  };
}

function shotPoint(input: AnalyzeInput, up: PixelPoint): PixelPoint {
  // 转正帧 -> 原始拍摄帧（保留像素级直接来源）
  const r = input.image.shotRotation;
  const inv = { 0: 0, 90: 270, 180: 180, 270: 90 } as const;
  const upW = input.upright.width;
  const upH = input.upright.height;
  let x = up.x;
  let y = up.y;
  switch (inv[r]) {
    case 0: break;
    case 90: { const nx = upH - 1 - up.y; const ny = up.x; x = nx; y = ny; break; }
    case 180: x = upW - 1 - up.x; y = upH - 1 - up.y; break;
    case 270: { const nx = up.y; const ny = upW - 1 - up.x; x = nx; y = ny; break; }
  }
  return { x, y, frame: 'shot' };
}
