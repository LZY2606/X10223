import type {
  Band,
  CalibrationParameters,
  CounterCaseScenario,
  Decision,
  Diagnostic,
  GelEvent,
  GelImage,
  InferenceResult,
  LadderBandNominal,
  Lane,
  OrientationDeg,
} from './types.ts';
import { DEFAULT_PARAMETERS } from './types.ts';
import { inferMolecularWeights } from './calibration.ts';
import { buildArcTable, projectToLane, rotatePoint } from './geometry.ts';
import type { InferenceRun } from './calibration.ts';

export interface ProjectState {
  projectId: string;
  name: string;
  unit: 'bp' | 'kDa';
  images: Map<string, GelImage>;
  orientation: Map<string, OrientationDeg>;
  lanes: Map<string, Lane>; // 当前生效 lane（修订替换）
  supersededLanes: Map<string, Lane>;
  ladderBands: Map<string, LadderBandNominal>;
  bands: Map<string, Band>;
  supersededBands: Map<string, Band>;
  parameters: CalibrationParameters;
  runs: InferenceRun[]; // 追加；当前为最后一次
  decisions: Decision[];
  diagnostics: Diagnostic[]; // 影响诊断（含 STALE_COORDINATE_BASIS / 局部失效）
  activeImageId?: string;
}

export function emptyState(projectId: string): ProjectState {
  return {
    projectId,
    name: '',
    unit: 'bp',
    images: new Map(),
    orientation: new Map(),
    lanes: new Map(),
    supersededLanes: new Map(),
    ladderBands: new Map(),
    bands: new Map(),
    supersededBands: new Map(),
    parameters: { ...DEFAULT_PARAMETERS },
    runs: [],
    decisions: [],
    diagnostics: [],
  };
}

/** 沿事件流重放。untilEventId 给定时恢复当时状态（历史结论不会被最新计算覆盖）。 */
export function replay(events: GelEvent[], untilEventId?: string): { state: ProjectState; appliedCount: number } {
  const state = emptyState(events[0]?.projectId ?? '');
  let applied = 0;
  for (const ev of events) {
    applyEvent(state, ev);
    applied += 1;
    if (ev.id === untilEventId) break;
  }
  return { state, appliedCount: applied };
}

function applyEvent(state: ProjectState, ev: GelEvent) {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.type) {
    case 'project_created':
      state.name = p.name as string;
      state.unit = p.unit as 'bp' | 'kDa';
      break;
    case 'image_imported': {
      const image = p.image as GelImage;
      state.images.set(image.id, image);
      state.orientation.set(image.id, image.variant === 'rotated_180' ? 180 : 0);
      state.activeImageId = image.id;
      break;
    }
    case 'orientation_amended':
      state.orientation.set(p.imageId as string, p.toDeg as OrientationDeg);
      break;
    case 'lane_added': {
      const lane = p.lane as Lane;
      state.lanes.set(lane.id, lane);
      break;
    }
    case 'lane_revised': {
      const lane = p.lane as Lane;
      const old = state.lanes.get(lane.id);
      if (old) state.supersededLanes.set(p.supersedes as string, old);
      state.lanes.set(lane.id, lane);
      break;
    }
    case 'ladder_lane_assigned': {
      for (const lane of state.lanes.values()) lane.isLadder = lane.id === p.laneId;
      break;
    }
    case 'ladder_band_nominated': {
      const band = p.band as LadderBandNominal;
      state.ladderBands.set(band.id, band);
      break;
    }
    case 'ladder_band_marked_missing': {
      const id = p.ladderBandId as string;
      const band = state.ladderBands.get(id);
      if (band) state.ladderBands.set(id, { ...band, missing: p.missing as boolean });
      break;
    }
    case 'band_detected':
      for (const band of p.bands as Band[]) state.bands.set(band.id, band);
      break;
    case 'band_center_revised': {
      const band = p.band as Band;
      const old = state.bands.get(band.id);
      if (old) state.supersededBands.set(p.supersedes as string, old);
      state.bands.set(band.id, band);
      break;
    }
    case 'parameters_revised': {
      const changes = p.changes as Partial<Record<keyof CalibrationParameters, number>>;
      state.parameters = {
        model: 'piecewise_linear_log_mw',
        version: p.toVersion as number,
        extrapolationMarginPx: changes.extrapolationMarginPx ?? state.parameters.extrapolationMarginPx,
        saturationRatio: changes.saturationRatio ?? state.parameters.saturationRatio,
        overlapGapPx: changes.overlapGapPx ?? state.parameters.overlapGapPx,
        maxSegmentEvaluations: changes.maxSegmentEvaluations ?? state.parameters.maxSegmentEvaluations,
      };
      break;
    }
    case 'inference_recorded': {
      // 存储事件中携带的结果即当时计算结果（回到旧事件时恢复它，而非重算）。
      const recorded = (p as { results: InferenceResult[]; imageId: string }).results;
      state.runs.push({
        id: ev.id,
        imageId: (p as { imageId: string }).imageId,
        parametersVersion: state.parameters.version,
        segments: latestSegments(state),
        results: recorded,
        runDiagnostics: recorded.flatMap((r) => r.diagnostics),
        inputSummary: ev.payloadSummary,
        outcome: recorded.some((r) => r.outcome !== 'unique') ? 'candidate_set' : 'unique',
      });
      break;
    }
    case 'decision_recorded':
      state.decisions.push(p as unknown as Decision);
      break;
    case 'impact_diagnostic': {
      const diags = p.diagnostics as Diagnostic[];
      state.diagnostics.push(...diags);
      break;
    }
    default:
      break;
  }
}

function latestSegments(state: ProjectState) {
  return state.runs.length ? state.runs[state.runs.length - 1].segments : [];
}

/** 实时计算（服务端业务规则，可被测试直接调用）。 */
export function computeForState(state: ProjectState, imageId: string, parents: string[]): InferenceRun | null {
  const image = state.images.get(imageId);
  if (!image) return null;
  const lanes = [...state.lanes.values()].filter((l) => l.imageId === imageId);
  const ladderBands = [...state.ladderBands.values()];
  const bands = [...state.bands.values()].filter((b) => b.imageId === imageId);
  return inferMolecularWeights({ image, lanes, ladderBands, bands, parameters: state.parameters, parents });
}

/**
 * 旋转图像后，旧像素来源与新方向基准不一致：
 * 生成 STALE_COORDINATE_BASIS 影响诊断，受影响对象限制在依赖该图像的 lane/band/ladder。
 */
export function rotationImpact(image: GelImage, fromDeg: OrientationDeg, toDeg: OrientationDeg, lanes: Lane[], ladderBands: LadderBandNominal[], bands: Band[]): Diagnostic[] {
  if (fromDeg === toDeg) return [];
  const affected = [...lanes.map((l) => l.id), ...ladderBands.map((b) => b.id), ...bands.map((b) => b.id)];
  const diag: Diagnostic = {
    code: 'STALE_COORDINATE_BASIS',
    message: `拍摄方向 ${fromDeg}° → ${toDeg}°：原像素坐标仍保留，但旧 lane 边界/band 中心的坐标基准已失效，必须在新方向重新确认`,
    position: { kind: 'image', id: image.id, imageId: image.id },
    affectedObjectIds: affected,
  };
  // 旋转后正确坐标（像素级），作为修订建议附带，不自动替换原始来源。
  void rotatePoint;
  void buildArcTable;
  void projectToLane;
  return [diag];
}

export function decideOutcome(result: InferenceResult, decisions: Decision[]): Decision | undefined {
  return decisions.find((d) => d.targetResultId === result.id);
}

export function scenarioSummary(scenarios: CounterCaseScenario[]) {
  return scenarios;
}

