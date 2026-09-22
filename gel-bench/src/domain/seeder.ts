import { Store } from '../storage/store';
import { GelEngine } from './engine';
import { buildCasePack } from './casepack';
import { buildMaterialsFromCase, resetFactoryClock } from './material-factory';
import { PARAM_V1, PARAM_V2 } from './params';
import { contentId } from './ids';
import { rotateGrayPng } from './gel-image';
import type { Material, PixelPoint, UnitName } from './types';

export interface SeedResult {
  baselineProjectId: string;
  scenarioProjectIds: Record<string, string>;
  casePack: ReturnType<typeof buildCasePack>;
}

/**
 * 播种离线案例：一个基线叙事项目 + 七个反例项目。
 * 每个反例都从基线只改动一个直接来源，重放记录实际经过规定情形。
 */
export function seedFromCasePack(store: Store, casePack = buildCasePack()): SeedResult {
  resetFactoryClock(1000);
  const engine = new GelEngine(store);
  const b = casePack.spec.baseline;
  const scenarioProjectIds: Record<string, string> = {};

  // ---------------- 基线项目：完整叙事 ----------------
  const basePng = casePack.files[b.pngName]!;
  const baseProj = engine.createProject(b.name, 'baseline', { case: 'baseline' });
  const baselineProjectId = baseProj.id;
  const baseImport = engine.importCaseMaterials(baselineProjectId, basePng, {
    projectName: b.name,
    pngBuffer: basePng,
    width: b.width,
    height: b.height,
    laneXs: b.laneXs,
    laneWidth: b.laneWidth,
    originY: b.originY,
    ladderSpec: b.ladder,
    saturatedPixels: [],
    exposureMs: b.exposure.exposureMs,
  });
  const baseLanes = baseImport.materials.filter((m): m is Extract<Material, { type: 'lane_trace' }> => m.type === 'lane_trace');

  // 初始自动分析（自动候选）
  const auto1 = engine.runAutoAnalysis(baselineProjectId);

  // 一次参数修订（v1 -> v2），重算但历史保留
  engine.reviseParameters(baselineProjectId, PARAM_V2.version, '收紧饱和阈值并加标尺余量');
  const auto2 = engine.runAutoAnalysis(baselineProjectId);

  // 采纳 ladder 唯一对齐与一个清晰样本带（自动 -> 人工确认）
  const sampleLane1 = baseLanes.find((l) => l.laneIndex === 1)!;
  const bandsAtV2 = store
    .listDerivedAt(baselineProjectId, auto2.event.id)
    .find((d) => d.kind === 'inference' && d.subjectId === sampleLane1.id);
  const firstClearBand = (bandsAtV2?.value as { candidates?: { bandId: string }[] }).candidates?.find((c) => true);
  if (firstClearBand) engine.acceptCandidate(baselineProjectId, firstClearBand.bandId, 0);

  // 一次只影响局部依赖的源数据改动：修订 lane#2 曲线 -> 仅该 lane 本地失效后重算
  const revisedLane = engine.shiftLaneTrace(baselineProjectId, sampleLane1.id, { y: 6 });
  engine.replaceSingleSource({
    projectId: baselineProjectId,
    kind: 'lane_trace',
    logicalId: sampleLane1.id,
    newMaterial: revisedLane,
    reason: '复核发现 lane#2 原点标注偏移 6px',
    affectedSubjects: [sampleLane1.id],
  });
  const auto3 = engine.runAutoAnalysis(baselineProjectId);
  void auto3;

  // 一次互相冲突的人工决定：同一带先接受点值，再在 human-alt 分支给区间/否定
  const anotherLane = baseLanes.find((l) => l.laneIndex === 2)!;
  const inf3 = store
    .listDerivedAt(baselineProjectId, auto3.event.id)
    .find((d) => d.kind === 'inference' && d.subjectId === anotherLane.id);
  const conflictBand = (inf3?.value as { candidates?: { bandId: string }[] }).candidates?.[0]?.bandId;
  if (conflictBand) {
    engine.acceptCandidate(baselineProjectId, conflictBand, 0);
    engine.conflictingDecision(baselineProjectId, conflictBand, 'accept-interval', 'human-alt');
  }

  // ---------------- 七个反例项目 ----------------
  for (const sc of casePack.spec.scenarios) {
    const png = casePack.files[sc.pngName]!;
    const proj = engine.createProject(sc.title, 'counterexample', { scenario: sc.key });
    scenarioProjectIds[sc.key] = proj.id;
    const ladderSpec = sc.ladderOverride ?? b.ladder;

    const importRes = engine.importCaseMaterials(proj.id, png, {
      projectName: sc.title,
      pngBuffer: png,
      width: b.width,
      height: b.height, // 工厂内部按 orientationDeg 交换帧尺寸
      laneXs: b.laneXs,
      laneWidth: b.laneWidth,
      originY: b.originY,
      ladderSpec,
      rotationDeg: sc.orientationDeg ?? 0,
      saturatedPixels: [],
      exposureMs: b.exposure.exposureMs,
    });

    if (sc.key === 'rotation') {
      // 先以错误方向分析失败/无意义，再应用方向修正事件，旋转使旧坐标全部需要帧迁移
      engine.store.appendEvent(
        proj.id,
        engine.store.getHead(proj.id, 'main').headEventId,
        'main',
        'annotation',
        { rotationDeg: sc.orientationDeg, frameShift: true },
        'human',
        { code: 'ROTATION_FRAME_SHIFT', note: '旧像素坐标属于旋转前帧，回正后必须迁移' }
      );
      engine.runAutoAnalysis(proj.id);
    } else if (sc.key === 'missing_band') {
      engine.runAutoAnalysis(proj.id, { acceptedAlignment: 0 });
    } else if (sc.key === 'local_failure') {
      const a1 = engine.runAutoAnalysis(proj.id);
      void a1;
      const lanes = importRes.materials.filter(
        (m): m is Extract<Material, { type: 'lane_trace' }> => m.type === 'lane_trace'
      );
      const lane1 = lanes.find((l) => l.laneIndex === 1)!;
      const moved = engine.shiftLaneTrace(proj.id, lane1.id, { y: 8 });
      engine.replaceSingleSource({
        projectId: proj.id,
        kind: 'lane_trace',
        logicalId: lane1.id,
        newMaterial: moved,
        reason: '接受结论后局部修订 lane 曲线',
        affectedSubjects: [lane1.id],
      });
      engine.runAutoAnalysis(proj.id);
    } else if (sc.key === 'smile') {
      engine.runAutoAnalysis(proj.id);
    } else {
      engine.runAutoAnalysis(proj.id);
    }
  }

  return { baselineProjectId, scenarioProjectIds, casePack };
}

/** 供测试直接使用：在内存库上重放单个情形 */
export function replayScenario(key: string, store: Store) {
  const pack = buildCasePack();
  const sc = pack.spec.scenarios.find((x) => x.key === key)!;
  resetFactoryClock(5000);
  const engine = new GelEngine(store);
  const b = pack.spec.baseline;
  const png = pack.files[sc.pngName]!;
  const proj = engine.createProject(sc.title, 'counterexample', { scenario: sc.key });
  const imported = engine.importCaseMaterials(proj.id, png, {
    projectName: sc.title,
    pngBuffer: png,
    width: b.width,
    height: b.height,
    laneXs: b.laneXs,
    laneWidth: b.laneWidth,
    originY: b.originY,
    ladderSpec: sc.ladderOverride ?? b.ladder,
    rotationDeg: sc.orientationDeg ?? 0,
    exposureMs: b.exposure.exposureMs,
  });
  if (sc.key === 'rotation') {
    engine.store.appendEvent(
      proj.id,
      engine.store.getHead(proj.id, 'main').headEventId,
      'main',
      'annotation',
      { rotationDeg: sc.orientationDeg, frameShift: true },
      'human',
      { code: 'ROTATION_FRAME_SHIFT' }
    );
  }
  const analysis =
    sc.key === 'missing_band'
      ? engine.runAutoAnalysis(proj.id, { acceptedAlignment: 0 })
      : engine.runAutoAnalysis(proj.id);
  return { projectId: proj.id, engine, imported, analysis, scenario: sc, baseline: b };
}

export { PARAM_V1, PARAM_V2, contentId };
export type { PixelPoint, UnitName };
