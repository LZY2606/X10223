import type {
  BandAnnotationMaterial, BandMwResult, ComputationNode, Diagnostic,
  ImageMaterial, LadderSpecMaterial, LaneGeometryMaterial, OrientationMaterial,
  ParamSet, Rotation, AutoPeak, ProfileSample, PixelPoint,
} from '../shared/types.js';
import { contentId, digestOf } from '../shared/digest.js';
import { decodePng, checkPixelBudget } from './image.js';
import { arcGeometry, projectPointToLane, rotateImage, rotateLanePoints, type PixelImage } from './geometry.js';
import { sampleLaneProfile, type ProfileOutcome } from './profile.js';
import { detectAutoPeaks } from './peaks.js';
import { alignLadderBands, buildCalibration } from './calibration.js';
import type { CalibrationResult } from '../shared/types.js';
import { inferBandMw } from './bandmw.js';

export interface AnalysisContext {
  imageMaterial: ImageMaterial;
  imageBytes: Buffer;
  orientation: OrientationMaterial;
  rotationApplied: Rotation;          // 来自 orientation-confirmed 事件
  ladder: LadderSpecMaterial;
  geometry: LaneGeometryMaterial;
  bands: BandAnnotationMaterial;
  params: ParamSet;
}

export interface AnalysisResult {
  nodes: ComputationNode[];
  diagnostics: Diagnostic[];
  profiles: Record<string, ProfileSample[]>;
  peaks: Record<string, AutoPeak[]>;
  calibration: CalibrationResult | null;
  bandResults: BandMwResult[];
  rotatedSize: { width: number; height: number };
  // 检查点：图上点（叠加显示用，已旋转到视图坐标）
  laneViewPoints: Record<string, { x: number; y: number }[]>;
}

export function runAnalysis(ctx: AnalysisContext): AnalysisResult {
  const nodes: ComputationNode[] = [];
  const diagnostics: Diagnostic[] = [];

  // 1) 解码（三种不同失败：CORRUPT_FORMAT / BUDGET_EXHAUSTED / SEMANTIC_NO_SOLUTION）
  const decoded = decodePng(ctx.imageBytes);
  const rotatedNodeInputs = [ctx.imageMaterial.blobSha256, ctx.rotationApplied, ctx.params.version];
  if (!decoded.ok) {
    const node: ComputationNode = {
      id: contentId('node-rot', rotatedNodeInputs), kind: 'rotated-image',
      subjectId: ctx.imageMaterial.id, status: 'corrupt-format',
      inputsDigest: digestOf(rotatedNodeInputs), paramsVersion: ctx.params.version,
      dependencies: [], diagnostics: [{ code: 'CORRUPT_FORMAT', message: decoded.message, path: ctx.imageMaterial.fileName }],
      result: null,
    };
    nodes.push(node);
    return { nodes, diagnostics: node.diagnostics, profiles: {}, peaks: {}, calibration: null, bandResults: [],
      rotatedSize: { width: 0, height: 0 }, laneViewPoints: {} };
  }

  // 2) 旋转派生图（拍摄方向核对）
  const view = rotateImage(decoded.image, ctx.rotationApplied);
  const budget = checkPixelBudget(view, ctx.params.maxPixels);
  nodes.push({
    id: contentId('node-rot', rotatedNodeInputs), kind: 'rotated-image',
    subjectId: ctx.imageMaterial.id, status: budget ? 'budget-exhausted' : 'ok',
    inputsDigest: digestOf(rotatedNodeInputs), paramsVersion: ctx.params.version,
    dependencies: [],
    diagnostics: budget ? [{ code: 'BUDGET_EXHAUSTED', message: `图像 ${budget.used} 像素超过预算 ${budget.limit}` }] : [],
    result: { rotationApplied: ctx.rotationApplied, width: view.width, height: view.height },
    budget: budget ? { used: budget.used, limit: budget.limit } : undefined,
  });
  if (budget) {
    return { nodes, diagnostics: nodes.flatMap((n) => n.diagnostics), profiles: {}, peaks: {}, calibration: null,
      bandResults: [], rotatedSize: { width: view.width, height: view.height }, laneViewPoints: {} };
  }

  // 3) 道曲线旋转到视图坐标
  const laneViewPoints: Record<string, PixelPoint[]> = {};
  const viewGeometry: LaneGeometryMaterial = {
    ...ctx.geometry,
    lanes: ctx.geometry.lanes.map((lane) => {
      const pts = rotateLanePoints(lane.points, ctx.rotationApplied, ctx.imageMaterial.width, ctx.imageMaterial.height);
      laneViewPoints[lane.laneId] = pts;
      return { ...lane, points: pts };
    }),
  };

  const profiles: Record<string, ProfileSample[]> = {};
  const peaks: Record<string, AutoPeak[]> = {};
  const outcomes: Record<string, ProfileOutcome> = {};
  const profileNodeIds: Record<string, string> = {};

  for (const lane of viewGeometry.lanes) {
    const outcome = sampleLaneProfile(view, lane, ctx.params);
    outcomes[lane.laneId] = outcome;
    profiles[lane.laneId] = outcome.profile;
    const inputs = [ctx.imageMaterial.blobSha256, lane.points, lane.halfWidthPx, ctx.params.version];
    const id = contentId('node-prof', [lane.laneId, digestOf(inputs)]);
    profileNodeIds[lane.laneId] = id;
    nodes.push({
      id, kind: 'lane-profile', subjectId: lane.laneId,
      status: outcome.diagnostics.some((d) => d.code === 'BUDGET_EXHAUSTED') ? 'budget-exhausted' : 'ok',
      inputsDigest: digestOf(inputs), paramsVersion: ctx.params.version,
      dependencies: [nodes[0].id], diagnostics: outcome.diagnostics,
      result: { length: outcome.totalLength, samples: outcome.profile.length, usedPixels: outcome.usedPixels },
    });

    if (outcome.profile.length) {
      const { peaks: autoPeaks, diagnostics: pdiag } = detectAutoPeaks(lane.laneId, outcome.profile, ctx.params);
      peaks[lane.laneId] = autoPeaks;
      const pinputs = [id, digestOf(outcome.profile.map((p) => [p.s.toFixed(1), p.intensity.toFixed(1), p.saturated])), ctx.params.version];
      nodes.push({
        id: contentId('node-peaks', [lane.laneId, digestOf(pinputs)]),
        kind: 'auto-peaks', subjectId: lane.laneId,
        status: pdiag.length ? 'candidate' : 'ok',
        inputsDigest: digestOf(pinputs), paramsVersion: ctx.params.version,
        dependencies: [id], diagnostics: pdiag,
        result: autoPeaks.map((p) => ({ s: p.s, saturated: p.saturated, tailed: p.tailed, overlapGroup: p.overlapGroup ?? null })),
      });
    }
  }
  diagnostics.push(...nodes.flatMap((n) => n.diagnostics));

  // 4) ladder 校准（局部标尺 + 有效区域）
  const ladderLane = viewGeometry.lanes.find((l) => l.role === 'ladder')!;
  const ladderBands = ctx.bands.bands.filter((b) => b.laneId === ladderLane.laneId);
  const sOf = (bandId: string) => {
    const b = ctx.bands.bands.find((x) => x.id === bandId)!;
    const center = rotatePointLocal(b.center, ctx.rotationApplied, ctx.imageMaterial.width, ctx.imageMaterial.height);
    const pr = projectPointToLane(center, ladderLane.points, outcomes[ladderLane.laneId]?.geometry ?? arcGeometry(ladderLane.points));
    const prof = outcomes[ladderLane.laneId]?.profile;
    const near = prof?.[Math.round(pr.s)];
    return { s: pr.s, saturated: near?.saturated ?? false };
  };
  const { aligned, missingOrdinals, diagnostics: alignDiag } = alignLadderBands(ctx.ladder, sOf, ladderBands);
  const calibration = buildCalibration(ladderLane.laneId, ctx.ladder, aligned, missingOrdinals);
  const calDiags = [...alignDiag, ...(!calibration.monotonic ? [{
    code: 'SEMANTIC_NO_SOLUTION' as const, path: `ladder:${ladderLane.laneId}`,
    message: '非单调标尺：局部校准语义无解', detail: { anchors: calibration.anchors.map((a) => ({ ordinal: a.ordinal, bp: a.bp, s: a.s })) },
  }] : [])];
  const calInputs = [ctx.ladder.entries.map((e) => [e.id, e.raw, e.nominalBp]), aligned.map((a) => [a.ordinal, a.s.toFixed(2), a.bandId]), ctx.params.version];
  const calNodeId = contentId('node-cal', [ladderLane.laneId, digestOf(calInputs)]);
  nodes.push({
    id: calNodeId,
    kind: 'lane-calibration', subjectId: ladderLane.laneId,
    status: !calibration.monotonic ? 'no-solution' : missingOrdinals.length ? 'candidate' : 'ok',
    inputsDigest: digestOf(calInputs), paramsVersion: ctx.params.version,
    dependencies: [profileNodeIds[ladderLane.laneId]],
    diagnostics: calDiags,
    result: { anchors: calibration.anchors, validRegion: calibration.validRegion, segmentCount: calibration.segments.length },
  });
  diagnostics.push(...calDiags);

  // 5) 每条人工条带：投影到所属道弧长 -> 局部插值
  const bandResults: BandMwResult[] = [];
  for (const band of ctx.bands.bands) {
    if (band.laneId === ladderLane.laneId) continue;
    const lane = viewGeometry.lanes.find((l) => l.laneId === band.laneId);
    if (!lane) continue;
    const center = rotatePointLocal(band.center, ctx.rotationApplied, ctx.imageMaterial.width, ctx.imageMaterial.height);
    const proj = projectPointToLane(center, lane.points, outcomes[lane.laneId]?.geometry ?? arcGeometry(lane.points));
    const prof = outcomes[lane.laneId]?.profile ?? [];
    const near = prof[Math.round(proj.s)];
    // 饱和判定：像素饱和 或 来源 kindHint（饱和区只给候选）
    const saturated = near?.saturated ?? band.kindHint === 'saturated';
    const tailed = band.kindHint === 'tailed';
    const res = inferBandMw({
      band, s: proj.s, saturated: !!saturated, tailed: !!tailed,
      autoPeaks: peaks[lane.laneId] ?? [], calibration,
    });
    bandResults.push(res);
    const mwInputs = [band.id, [proj.s.toFixed(2), saturated, tailed], calNodeId, ctx.params.version];
    nodes.push({
      id: contentId('node-mw', [band.id, digestOf(mwInputs)]),
      kind: 'band-mw', subjectId: band.id, status: res.status,
      inputsDigest: digestOf(mwInputs), paramsVersion: ctx.params.version,
      dependencies: [profileNodeIds[lane.laneId], calNodeId],
      diagnostics: res.diagnostics,
      result: { s: res.s, candidates: res.candidates, autoMatched: res.autoMatched ?? null },
    });
  }

  return {
    nodes, diagnostics, profiles, peaks, calibration, bandResults,
    rotatedSize: { width: view.width, height: view.height }, laneViewPoints,
  };
}

function rotatePointLocal(p: { x: number; y: number }, rot: Rotation, w: number, h: number) {
  switch (rot) {
    case 0: return { ...p };
    case 90: return { x: h - 1 - p.y, y: p.x };
    case 180: return { x: w - 1 - p.x, y: h - 1 - p.y };
    case 270: return { x: p.y, y: w - 1 - p.x };
  }
}
