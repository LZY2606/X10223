import type {
  BandObservation,
  CalibParamsV1,
  CalibSegment,
  DecisionEvent,
  DerivedEnvelope,
  DerivedLane,
  Diagnostic,
  GelEvent,
  ImageMaterial,
  LadderLaneMaterial,
  LaneMaterial,
  Material,
  BandResult,
  Snapshot,
  InputDigest,
  ComputeBudget,
} from '../shared/types.ts';
import { DEFAULT_CALIB_PARAMS_V1, RULES_VERSION } from '../shared/types.ts';
import {
  projectToPolyline,
  cloneParams,
  sampleMaterialsDigest,
  sha256Text,
  canonicalJson,
  transformPixelBuffer,
} from '../shared/util.ts';
import {
  bandsOnArc,
  calibrateLadder,
  inferBandMw,
  BudgetExhaustedError,
} from './calibrate.ts';

export interface ReplayState {
  projectId: string;
  branch: string;
  /** 图像像素库 sha -> bytes（旋转需要） */
  pixelStore: Map<string, Uint8Array>;
  currentImageId: string | null;
  materials: Map<string, Material>;
  laneOrder: string[];
  paramsVersion: number;
  params: CalibParamsV1;
  decisions: DecisionEvent[];
  /** 被人工删除的 band（后续重放不得让检测器“复活”） */
  removedBands: Set<string>;
  lastDerivedEventId: string | null;
  lastDigest: InputDigest | null;
}

export class SemanticError extends Error {
  constructor(public diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('; '));
    this.name = 'SemanticError';
  }
}

export class IncompleteInputError extends Error {
  constructor(public diagnostics: Diagnostic[]) {
    super(diagnostics.map((d) => d.message).join('; '));
    this.name = 'IncompleteInputError';
  }
}

export function initState(projectId: string, branch: string, pixelStore: Map<string, Uint8Array>): ReplayState {
  return {
    projectId,
    branch,
    pixelStore,
    currentImageId: null,
    materials: new Map(),
    laneOrder: [],
    paramsVersion: 0,
    params: { ...DEFAULT_CALIB_PARAMS_V1 },
    decisions: [],
    removedBands: new Set(),
    lastDerivedEventId: null,
    lastDigest: null,
  };
}

export function applyEvent(
  state: ReplayState,
  evt: GelEvent,
  opts: { recompute: boolean; budget: ComputeBudget },
): Snapshot | null {
  switch (evt.type) {
    case 'materials_imported': {
      for (const m of evt.materials ?? []) state.materials.set(m.id, m);
      state.currentImageId = evt.imageId;
      const lanes = (evt.materials ?? []).filter((m): m is LaneMaterial => m.kind === 'lane');
      state.laneOrder = lanes.sort((a, b) => a.index - b.index).map((l) => l.id);
      state.lastDigest = evt.inputDigest;
      break;
    }
    case 'image_rotated': {
      const src = state.materials.get(evt.sourceImageId);
      if (!src || src.kind !== 'gel-image') {
        throw new SemanticError([
          {
            code: 'incomplete-input',
            severity: 'error',
            at: { pixel: { x: 0, y: 0, frame: 'image' } },
            message: `旋转事件 ${evt.id} 引用的源图 ${evt.sourceImageId} 不存在`,
          },
        ]);
      }
      const srcPixels = state.pixelStore.get(src.pixelsSha256);
      if (!srcPixels) {
        throw new SemanticError([
          { code: 'incomplete-input', severity: 'error', message: '源图像素不在像素库中，无法重放旋转' },
        ]);
      }
      const newImg = (evt.materials ?? []).find((m) => m.id === evt.newImageId) as ImageMaterial | undefined;
      if (!newImg) throw new SemanticError([{ code: 'incomplete-input', severity: 'error', message: '旋转事件缺少新图材料' }]);
      // 像素级来源校验：重放旋转必须与事件保存的哈希一致
      const rotated = transformPixelBuffer(srcPixels, src.width, src.height, evt.rotate, false, false);
      state.pixelStore.set(newImg.pixelsSha256, rotated.pixels);
      for (const m of evt.materials ?? []) state.materials.set(m.id, m);
      // 把既有 lane 折线与 band 锚点刚体重投影到新帧
      reprojectAnchors(state, src, newImg, evt.rotate);
      state.currentImageId = newImg.id;
      break;
    }
    case 'bands_auto_detected': {
      for (const m of evt.materials ?? []) {
        if (m.kind === 'band' && !state.removedBands.has(m.id)) state.materials.set(m.id, m);
      }
      break;
    }
    case 'band_added':
    case 'band_revised': {
      for (const m of evt.materials ?? []) {
        if (m.kind === 'band') {
          state.materials.set(m.id, m);
          state.removedBands.delete(m.id);
        }
      }
      break;
    }
    case 'band_removed': {
      state.materials.delete(evt.bandId);
      state.removedBands.add(evt.bandId);
      break;
    }
    case 'lane_revised': {
      for (const m of evt.materials ?? []) if (m.kind === 'lane') state.materials.set(m.id, m);
      break;
    }
    case 'decision': {
      state.decisions = [...state.decisions.filter((d) => d.targetSlotId !== evt.targetSlotId), evt];
      break;
    }
    case 'parameter_revised': {
      state.paramsVersion = evt.paramsVersion;
      state.params = cloneParams({ ...state.params, ...evt.patch });
      break;
    }
    default: {
      const _exhaustive: never = evt;
      throw new Error(`未知事件类型: ${JSON.stringify(_exhaustive)}`);
    }
  }
  return opts.recompute ? computeSnapshot(state, evt, opts.budget) : null;
}

function reprojectAnchors(
  state: ReplayState,
  src: ImageMaterial,
  dst: ImageMaterial,
  rotate: 0 | 90 | 180 | 270,
): void {
  const rot = (x: number, y: number) => {
    if (rotate === 90) return { x: src.height - 1 - y, y: x };
    if (rotate === 180) return { x: src.width - 1 - x, y: src.height - 1 - y };
    if (rotate === 270) return { x: y, y: src.width - 1 - x };
    return { x, y };
  };
  const frame = `image-rot${rotate}` as const;
  for (const m of [...state.materials.values()]) {
    if (m.kind === 'lane') {
      const warp = (pts: typeof m.centerline) =>
        pts.map((p) => ({ ...rot(p.x, p.y), frame }));
      state.materials.set(m.id, {
        ...m,
        centerline: warp(m.centerline),
        leftBoundary: warp(m.leftBoundary),
        rightBoundary: warp(m.rightBoundary),
      });
    } else if (m.kind === 'band') {
      const c = rot(m.center.x, m.center.y);
      state.materials.set(m.id, {
        ...m,
        center: { x: c.x, y: c.y, frame },
        cluster: m.cluster?.map((p) => ({ ...rot(p.x, p.y), frame })),
        arcS: { ...m.arcS, value: m.arcS.value },
      });
    }
  }
}

function currentMaterials(state: ReplayState) {
  const image = [...state.materials.values()].find(
    (m): m is ImageMaterial => m.kind === 'gel-image' && m.id === state.currentImageId,
  );
  const ladder = [...state.materials.values()].find(
    (m): m is LadderLaneMaterial => m.kind === 'ladder-lane',
  );
  const lanes = state.laneOrder
    .map((id) => state.materials.get(id))
    .filter((m): m is LaneMaterial => !!m && m.kind === 'lane');
  const bands = [...state.materials.values()].filter(
    (m): m is BandObservation => m.kind === 'band',
  );
  return { image, ladder, lanes, bands };
}

export function validateCompleteness(
  image: ImageMaterial | undefined,
  ladder: LadderLaneMaterial | undefined,
  lanes: LaneMaterial[],
  bands: BandObservation[],
): Diagnostic[] {
  const diags: Diagnostic[] = [];
  if (!image)
    diags.push({ code: 'incomplete-input', severity: 'error', message: '缺少原始凝胶图像' });
  if (!ladder || ladder.nominals.length < 2)
    diags.push({ code: 'incomplete-input', severity: 'error', message: 'ladder 标称值不足，无法校准' });
  if (lanes.length === 0)
    diags.push({ code: 'incomplete-input', severity: 'error', message: '缺少 lane 边界材料' });
  if (!lanes.some((l) => l.role === 'ladder'))
    diags.push({ code: 'incomplete-input', severity: 'error', message: '没有标记为 ladder 的 lane' });
  if (bands.length === 0)
    diags.push({ code: 'incomplete-input', severity: 'error', message: '尚未产生任何条带证据' });
  return diags;
}

export function computeSnapshot(
  state: ReplayState,
  evt: GelEvent,
  budget: ComputeBudget,
): Snapshot {
  const { image, ladder, lanes, bands } = currentMaterials(state);
  const completeness = validateCompleteness(image, ladder, lanes, bands);
  const fatal = completeness.filter((d) => d.severity === 'error');
  if (fatal.length || !image || !ladder) {
    throw new IncompleteInputError(fatal.length ? fatal : completeness);
  }

  // 重算所有 band 弧长（lane 修订后位置随之变；arcS 是派生几何量）
  const refreshed = bands.map((b) => {
    const lane = lanes.find((l) => l.id === b.laneId);
    if (!lane) return b;
    const proj = projectToPolyline(b.center.x, b.center.y, lane.centerline);
    return { ...b, arcS: { value: Math.round(proj.s * 100) / 100, unit: 'lane-arc-px' as const } };
  });

  // 每个 ladder lane 一条局部标尺（微笑：标尺属于 lane，不是全局水平线）
  const calibrations: Record<string, ReturnType<typeof calibrateLadder>> = {};
  const diagnostics: Diagnostic[] = [...completeness];
  let exhausted = false;
  for (const lane of lanes.filter((l) => l.role === 'ladder')) {
    const outcome = calibrateLadder(lane, ladder, refreshed, state.params, budget);
    calibrations[lane.id] = outcome;
    diagnostics.push(...outcome.calibration.diagnostics);
    exhausted = exhausted || outcome.exhausted;
  }
  if (exhausted) {
    throw new BudgetExhaustedError(budget.maxMatchings, budget);
  }

  // 所有 sample lane 共用 ladder 标尺，但每个 band 用自己泳道的弧长 s 查表
  // （微笑弯曲：同 y 不同 s；局部标尺带有效区域）
  const ladderLaneId = lanes.find((l) => l.role === 'ladder')?.id;
  const sharedCalib = ladderLaneId ? calibrations[ladderLaneId] : undefined;
  const derivedLanes: DerivedLane[] = lanes.map((lane) => {
    const calib = lane.role === 'ladder' ? calibrations[lane.id] : sharedCalib;
    const arcBands = bandsOnArc(lane, refreshed);
    const bandResults: BandResult[] = arcBands.map((ab) => {
      const my = calib
        ? inferBandMw(
            ab.arcS,
            calib.calibration.segments,
            state.params,
            (calib.bandCandidates.get(ab.band.id) ?? []).slice(),
            ab.band.flag,
          )
        : {
            autoMw: null,
            interval: null,
            segmentIndex: null,
            diagnostics: [
              { code: 'outside-valid-region', severity: 'error', message: '该 lane 无局部标尺' } as Diagnostic,
            ],
          };
      const decision = state.decisions.find((d) => d.targetSlotId === ab.band.id);
      let status: BandResult['status'] = 'candidate';
      if (decision?.kind === 'accept') status = 'accepted';
      if (decision?.kind === 'reject') status = 'rejected';
      if (decision?.kind === 'interval') status = 'interval';
      if (decision?.kind === 'conflict') status = 'conflict';
      if (
        !decision &&
        ab.band.flag !== 'normal' &&
        (my.autoMw === null || my.interval !== null)
      ) {
        status = 'candidate';
      }
      let bandDiags = my.diagnostics;
      if (decision?.kind === 'conflict') {
        bandDiags = [
          ...bandDiags,
          {
            code: 'conflicting-decisions',
            severity: 'warning',
            at: { slotId: ab.band.id },
            message: `同一显示值存在互斥人工决定：${decision.conflicts?.map((c) => c.kind).join(' vs ')}`,
          },
        ];
      }
      return {
        slotId: ab.band.id,
        bandId: ab.band.id,
        laneId: lane.id,
        arcS: Math.round(ab.arcS * 100) / 100,
        center: ab.band.center,
        flag: ab.band.flag,
        autoMw: my.autoMw === null ? null : Math.round(my.autoMw * 10) / 10,
        candidates: [...new Set((calib?.bandCandidates.get(ab.band.id) ?? []).map((v) => Math.round(v * 10) / 10))],
        interval: my.interval ? ([Math.round(my.interval[0]), Math.round(my.interval[1])] as [number, number]) : null,
        segmentIndex: my.segmentIndex,
        status,
        diagnostics: bandDiags,
        profileResidual: 0,
      };
    });
    return {
      laneId: lane.id,
      role: lane.role,
      curveResidual: Math.round(laneCurveResidual(lane) * 1000) / 1000,
      bands: bandResults,
    };
  });

  // 输入摘要（当前材料版本）
  const digest = sampleMaterialsDigest({ image, ladder, lanes, bands: refreshed });
  const dependencies: Record<string, string> = {};
  dependencies[`image@${image.id}`] = image.pixelsSha256.slice(0, 16);
  dependencies[`ladder@${ladder.id}`] = digest.ladderNominals.slice(0, 16);
  for (const lane of lanes) dependencies[`lane@${lane.id}`] = sha256Text(canonicalJson(lane.centerline)).slice(0, 16);
  dependencies[`params@v${state.paramsVersion}`] = sha256Text(canonicalJson(state.params)).slice(0, 16);

  const derived: DerivedEnvelope = {
    rulesVersion: RULES_VERSION,
    inputDigest: digest,
    paramsVersion: state.paramsVersion,
    params: state.params,
    dependencies,
    parentDerivedEventId: state.lastDerivedEventId,
    lanes: derivedLanes,
    calibrations: Object.fromEntries(
      Object.entries(calibrations).map(([id, c]) => [id, c.calibration]),
    ),
    diagnostics,
    computedAt: evt.at,
  };
  state.lastDerivedEventId = evt.id;
  state.lastDigest = digest;

  return {
    projectId: state.projectId,
    branch: state.branch,
    eventId: evt.id,
    eventSeq: evt.seq,
    currentImageId: image.id,
    materials: [image, ladder, ...lanes, ...refreshed],
    paramsVersion: state.paramsVersion,
    params: state.params,
    decisions: state.decisions,
    derived,
  };
}

/** lane 曲线残差：边界锚点相对中心线的偏移 RMS（像素级证据） */
function laneCurveResidual(lane: LaneMaterial): number {
  const residualFor = (pts: typeof lane.leftBoundary) => {
    if (pts.length === 0) return 0;
    let se = 0;
    for (const p of pts) {
      const proj = projectToPolyline(p.x, p.y, lane.centerline);
      se += proj.t * proj.t;
    }
    return Math.sqrt(se / pts.length);
  };
  return Math.max(residualFor(lane.leftBoundary), residualFor(lane.rightBoundary));
}

/** 分支级完整重放（事件必须按 seq 顺序；分支用 parentEventId 链式裁剪） */
export function replayBranch(
  projectId: string,
  branch: string,
  events: GelEvent[],
  pixelStore: Map<string, Uint8Array>,
  budget: ComputeBudget,
): { snapshots: Snapshot[]; final: Snapshot } {
  const ordered = events.filter((e) => e.branch === branch).sort((a, b) => a.seq - b.seq);
  const state = initState(projectId, branch, pixelStore);
  const snapshots: Snapshot[] = [];
  let final: Snapshot | null = null;
  for (const evt of ordered) {
    final = applyEvent(state, evt, { recompute: true, budget });
    if (final) snapshots.push(final);
  }
  if (!final) throw new IncompleteInputError([{ code: 'incomplete-input', severity: 'error', message: `分支 ${branch} 无可重放事件` }]);
  return { snapshots, final };
}
