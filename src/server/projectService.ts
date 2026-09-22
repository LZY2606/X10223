import { GelStore } from './store';
import {
  applyEvent,
  emptyProject,
  gelInputOf,
  replay,
  type ProjectState,
} from '../provenance/reducer';
import { hashEvent, makeEvent, type DecisionDetail, type EvidenceJudgmentPayload, type ProvenanceEvent } from '../provenance/events';
import { analyze, type AnalysisResult } from '../core/analyze';
import { detectLanes } from '../core/autolane';
import { annotateOverlaps, peaksToBands } from '../core/detection';
import { curvatureSmile, projectToLane } from '../core/geometry';
import { canonicalJson, sha256Hex, stableId } from '../shared/ids';
import { SemanticUnresolvableError } from '../shared/diagnostic';
import type { BandAnnotation, ImageMaterial, LadderMaterial, LaneAnnotation } from '../core/types';

const now = () => new Date().toISOString();

/**
 * 服务端业务编排。所有计算都在这里发生，浏览器只负责显示与发命令。
 * 状态整体序列化为 JSON（灰度像素单独入 materials blob）。
 */
export class ProjectService {
  constructor(private store: GelStore) {}

  createProject(projectId: string, name: string): ProjectState {
    const state = emptyProject(projectId, name, now());
    const created = makeEvent({
      seq: 0,
      branchId: 'main',
      type: 'project-created',
      paramVersion: state.branches.get('main')!.paramVersion,
      payload: { name },
      parents: [],
      prevHash: '',
      timestamp: state.createdAt,
    });
    state.events.push(created);
    this.persist(state);
    return state;
  }

  load(projectId: string): ProjectState {
    const json = this.store.getStateJson(projectId);
    if (!json) throw new SemanticUnresolvableError(`项目不存在 ${projectId}`);
    return deserializeState(json, this.store, projectId);
  }

  importMaterials(projectId: string, image: ImageMaterial, ladder: LadderMaterial): ProjectState {
    const state = this.loadOrSeed(projectId);
    const event = this.append(
      state,
      'materials-imported',
      state.branches.get(state.headBranchId)!.paramVersion,
      {
        imageMaterialId: image.materialId,
        ladderMaterialId: ladder.materialId,
        image: serializeImage(image),
        ladder,
      },
      [image.materialId, ladder.materialId],
    );
    // 立即物化材料（事件负载含完整内容，replay 也会重建）。
    applyEvent(state, event);
    this.store.putMaterial(projectId, image.materialId, 'raw-gel-image', JSON.stringify(serializeImage(image)), image.grayscale);
    this.persist(state);
    return state;
  }

  /** 自动分析：自动 lane 候选 + band 候选 + 校准 + 推断。 */
  runAutoAnalysis(projectId: string, branchId = 'main'): { state: ProjectState; result: AnalysisResult } {
    const state = this.load(projectId);
    const branch = state.branches.get(branchId)!;
    const input = gelInputOf(state, branch);
    const eventId = stableId('evt-pending', state.events.length, 'auto-analysis');
    const autoLanes = detectLanes(input.image, eventId);
    // 案例包通常已提供真值 lanes；自动分析仅在缺省时补 lane，band 总是自动检测。
    const lanes = branch.lanes.length ? branch.lanes : autoLanes;
    // 已有像素级 band 标注（含配方真值/人工修订）则沿用；否则自动检测候选。
    let bands: BandAnnotation[];
    if (branch.bands.length) {
      bands = annotateOverlaps(branch.bands).map((b) => {
        const lane = lanes.find((l) => l.laneId === b.laneId)!;
        return { ...b, arcLengthPx: projectToLane(lane, b.center).s };
      });
    } else {
      const autoBandLists: BandAnnotation[] = [];
      for (const lane of lanes) autoBandLists.push(...peaksToBands(input.image, lane, eventId));
      bands = annotateOverlaps(autoBandLists).map((b) => {
        const lane = lanes.find((l) => l.laneId === b.laneId)!;
        return { ...b, arcLengthPx: projectToLane(lane, b.center).s };
      });
    }
    const result = analyze(input, eventId, { lanes, bands });
    const snapshot = {
      snapshotId: stableId('snap', eventId),
      producerEventId: eventId,
      result,
      adopted: {},
      createdAt: now(),
    };
    const event = this.append(state, 'auto-analysis', branch.paramVersion, {
      snapshot,
      lanes,
      bands,
      diagnostics: result.diagnostics,
    }, [state.materialBindings.imageMaterialId, state.materialBindings.ladderMaterialId]);
    applyEvent(state, event);
    this.emitJudgments(state, result, [snapshot.snapshotId]);
    this.persist(state);
    return { state, result };
  }

  /** 用当前（可能已修订的）lanes/bands 重算并写 parameter-revised 事件。 */
  reviseAndRecompute(projectId: string, branchId: string, paramVersion: string): ProjectState {
    const state = this.load(projectId);
    const branch = state.branches.get(branchId)!;
    const input = gelInputOf(state, branch);
    const result = analyze(input, stableId('evt-pending', state.events.length, 'revise'), {
      lanes: branch.lanes,
      bands: branch.bands,
    });
    const snapshot = {
      snapshotId: stableId('snap', paramVersion, state.events.length + 1),
      producerEventId: stableId('evt-pending', state.events.length, 'revise'),
      result,
      adopted: branch.adopted,
      createdAt: now(),
    };
    const event = this.append(state, 'parameter-revised', paramVersion, {
      paramVersion,
      snapshot,
      diagnostics: result.diagnostics,
      previousParamVersion: branch.paramVersion,
    }, [branch.latestAnalysis?.snapshotId ?? 'none'].filter(Boolean));
    applyEvent(state, event);
    if (result.fits.length) this.emitJudgments(state, result, [snapshot.snapshotId]);
    this.persist(state);
    return state;
  }

  /** 人工修订 lane/band（新身份、supersedes 旧身份，不覆盖）。 */
  reviseBand(projectId: string, branchId: string, bandId: string, newCenter: { x: number; y: number }, note: string): ProjectState {
    const state = this.load(projectId);
    const branch = state.branches.get(branchId)!;
    const old = branch.bands.find((b) => b.bandId === bandId);
    if (!old) throw new SemanticUnresolvableError(`待修订条带不存在 ${bandId}`);
    const lane = branch.lanes.find((l) => l.laneId === old.laneId)!;
    const proj = projectToLane(lane, { x: newCenter.x, y: newCenter.y, frame: 'original-pixel' });
    const revised: BandAnnotation = {
      ...old,
      bandId: stableId('band', old.laneId, newCenter.x, newCenter.y, 'rev', state.events.length + 1),
      center: { x: newCenter.x, y: newCenter.y, frame: 'original-pixel' },
      arcLengthPx: Math.round(proj.s * 100) / 100,
      overlapsWith: [],
      provenance: {
        role: 'manual-revision',
        frame: 'original-pixel',
        producerEventId: undefined,
        confidence: 1,
        note,
      },
      supersedesBandId: old.bandId,
    };
    const event = this.append(state, 'bands-annotated', branch.paramVersion, { bands: [revised] }, [old.bandId]);
    applyEvent(state, event);
    this.persist(state);
    return state;
  }

  reviseLaneCurve(projectId: string, branchId: string, laneId: string, points: { x: number; y: number }[], note: string): ProjectState {
    const state = this.load(projectId);
    const branch = state.branches.get(branchId)!;
    const old = branch.lanes.find((l) => l.laneId === laneId);
    if (!old) throw new SemanticUnresolvableError(`待修订泳道不存在 ${laneId}`);
    // lane 身份保持稳定（bands 依赖它）；修订体现在 provenance 与事件历史。
    const revised: LaneAnnotation = {
      ...old,
      centerline: { points: points.map((p) => ({ ...p, frame: 'original-pixel' as const })) },
      provenance: { role: 'manual-revision', frame: 'original-pixel', confidence: 1, note },
    };
    // 该道条带按新中心线重投影弧长（像素中心不变）。
    const reprojBands: BandAnnotation[] = branch.bands
      .filter((b) => b.laneId === laneId)
      .map((b) => ({ ...b, arcLengthPx: Math.round(projectToLane(revised, b.center).s * 100) / 100 }));
    const event = this.append(state, 'lanes-annotated', branch.paramVersion, {
      lanes: [revised],
      bands: reprojBands,
    }, [old.laneId]);
    applyEvent(state, event);
    this.persist(state);
    return state;
  }

  /** 人工接受/否定/调整，生成新决定事件（不覆盖历史）。 */
  decide(projectId: string, branchId: string, detail: Omit<DecisionDetail, 'decisionId'>): ProjectState {
    const state = this.load(projectId);
    const branch = state.branches.get(branchId)!;
    const decision: DecisionDetail = {
      ...detail,
      decisionId: stableId('dec', branchId, detail.targetId, detail.action, canonicalJson(detail.acceptedCandidateId ?? detail.rejectedCandidateIds ?? detail.adjustment ?? detail.reason), state.events.length + 1),
    };
    const event = this.append(state, 'decision', branch.paramVersion, { decision }, [detail.targetId]);
    applyEvent(state, event);
    this.persist(state);
    return state;
  }

  createBranch(projectId: string, newBranchId: string, fromBranchId: string): ProjectState {
    const state = this.load(projectId);
    const event = this.append(state, 'branch-created', state.branches.get(fromBranchId)!.paramVersion, {
      newBranchId,
      fromBranchId,
      forkedFromEventId: state.events[state.events.length - 1]?.eventId ?? null,
    }, [fromBranchId]);
    applyEvent(state, event);
    state.headBranchId = newBranchId;
    this.persist(state);
    return state;
  }

  /** 回到任意旧事件：用当时依赖版本重放，返回只读历史状态。 */
  viewAt(projectId: string, eventId: string): ProjectState {
    const current = this.load(projectId);
    return replay(current, eventId);
  }

  /** 通用事件追加（lanes/bands/source 等），供种子与 API 使用。 */
  appendGeneric(
    projectId: string,
    type: ProvenanceEvent['type'],
    payload: Record<string, unknown>,
    parents: string[] = [],
    branchId?: string,
  ): ProjectState {
    const state = this.load(projectId);
    const target = branchId ?? state.headBranchId;
    state.headBranchId = target;
    const event = this.append(state, type, state.branches.get(target)!.paramVersion, payload, parents);
    applyEvent(state, event);
    this.persist(state);
    return state;
  }

  /** 把本次分析的关键裁决落为机器可读 evidence-judgment 事件。 */
  private emitJudgments(state: ProjectState, result: AnalysisResult, parents: string[]) {
    const branch = state.branches.get(state.headBranchId)!;
    const bandsById = new Map(branch.bands.map((b) => [b.bandId, b]));
    const judgments: EvidenceJudgmentPayload[] = [];
    const orientationError = result.diagnostics.find((d) => d.code === 'orientation-mismatch');
    if (orientationError) {
      judgments.push({
        ruleId: 'orientation-content-mismatch',
        ruleVersion: 'rule.orientation.v1',
        subjectKind: 'lane',
        subjectId: branch.lanes.find((l) => l.role === 'ladder')?.laneId ?? 'ladder',
        severity: 'error',
        measurements: {},
        verdict: 'reject',
        affectedObjectIds: branch.bands.map((b) => b.bandId),
        message: orientationError.message,
      });
    }
    const laneById = new Map(branch.lanes.map((l) => [l.laneId, l]));

    for (const inf of result.inferences) {
      const band = bandsById.get(inf.bandId);
      const cand = inf.candidates[0];
      const base = {
        subjectKind: 'inference' as const,
        subjectId: inf.inferenceId,
        affectedObjectIds: [inf.bandId, inf.laneId],
        measurements: {
          arcLength: { value: inf.inputSummary.arcLengthPx as number, unit: 'px', frame: 'arc-length' },
        },
      };
      const msg = (code: string) => inf.diagnostics.find((d) => d.code === code)?.message;
      if (inf.diagnostics.some((d) => d.code === 'curved-lane-requires-local-scale')) {
        judgments.push({
          ...base,
          ruleId: 'smile-needs-local-scale',
          ruleVersion: 'rule.smile.v1',
          severity: 'warning',
          verdict: inf.status === 'unique' ? 'allow-unique' : 'downgrade-candidates',
          validRegion: cand ? { ...cand.validRegion, frame: 'arc-length+pixel' } : undefined,
          measurements: {
            ...base.measurements,
            curvature: { value: inf.inputSummary.curvaturePx as number, unit: 'px', frame: 'original-pixel' },
          },
          message: msg('curved-lane-requires-local-scale') ?? '微笑弯曲：同一像素高度不等于同一分子量，使用带有效区域的局部弧长标尺',
        });
      }
      if (inf.diagnostics.some((d) => d.code === 'saturated-band')) {
        judgments.push({ ...base, ruleId: 'saturated-candidate-only', ruleVersion: 'rule.saturated.v1', severity: 'warning', verdict: 'downgrade-candidates', message: msg('saturated-band') ?? '饱和条带仅标为候选/区间' });
      }
      if (band?.tailed || inf.diagnostics.some((d) => d.code === 'tailed-band')) {
        judgments.push({ ...base, ruleId: 'tail-interval-only', ruleVersion: 'rule.tail.v1', severity: 'warning', verdict: 'downgrade-interval', message: msg('tailed-band') ?? '拖尾条带给区间' });
      }
      if (band?.overlapsWith.length || inf.diagnostics.some((d) => d.code === 'overlapping-bands')) {
        judgments.push({
          ...base,
          ruleId: 'overlap-candidate-set',
          ruleVersion: 'rule.overlap.v1',
          severity: 'warning',
          verdict: 'downgrade-candidates',
          affectedObjectIds: [inf.bandId, ...(band?.overlapsWith ?? [])],
          message: msg('overlapping-bands') ?? '重叠保留全部合法候选',
        });
      }
      if (inf.diagnostics.some((d) => d.code === 'missing-ladder-band')) {
        judgments.push({ ...base, ruleId: 'missing-span-coarse-interval', ruleVersion: 'rule.missing.v1', severity: 'warning', verdict: 'downgrade-interval', message: '缺带跨度仅支持粗区间' });
      }
      if (inf.status === 'unresolved' && inf.diagnostics.some((d) => d.code === 'non-monotonic-calibration')) {
        judgments.push({ ...base, ruleId: 'non-monotonic-unresolvable', ruleVersion: 'rule.nonmono.v1', severity: 'error', verdict: 'reject', message: '非单调标尺语义无解' });
      }
      if (inf.status === 'unresolved' && inf.diagnostics.some((d) => d.code === 'outside-valid-region')) {
        judgments.push({ ...base, ruleId: 'outside-valid-region-unresolvable', ruleVersion: 'rule.region.v1', severity: 'error', verdict: 'reject', message: '出有效区域，拒绝外推' });
      }
    }

    // 泳道级微笑判断（即使该道推断唯一也记录曲率证据）。
    for (const lane of branch.lanes) {
      if (lane.role !== 'sample') continue;
      const existing = judgments.some((j) => j.ruleId === 'smile-needs-local-scale' && j.affectedObjectIds.includes(lane.laneId));
      if (existing) continue;
      const curve = curvatureSmile(lane);
      if (curve > 4) {
        judgments.push({
          ruleId: 'smile-needs-local-scale',
          ruleVersion: 'rule.smile.v1',
          subjectKind: 'lane',
          subjectId: lane.laneId,
          severity: 'warning',
          measurements: { curvature: { value: Math.round(curve * 100) / 100, unit: 'px', frame: 'original-pixel' } },
          verdict: 'allow-unique',
          affectedObjectIds: branch.bands.filter((b) => b.laneId === lane.laneId).map((b) => b.bandId),
          message: `泳道“微笑”曲率 ${curve.toFixed(1)}px，局部标尺按弧长分段并带有效区域`,
        });
      }
    }

    for (const j of judgments) {
      const ev = this.append(state, 'evidence-judgment', branch.paramVersion, { judgment: j }, parents);
      applyEvent(state, ev);
    }
    void laneById;
  }

  persistPublic(state: ProjectState) {
    this.persist(state);
  }

  /** 内部：若项目尚未物理创建则内存建立（供导入用）。 */
  private loadOrSeed(projectId: string): ProjectState {
    const json = this.store.getStateJson(projectId);
    if (json) return deserializeState(json, this.store, projectId);
    return this.createProject(projectId, projectId);
  }

  private append(
    state: ProjectState,
    type: ProvenanceEvent['type'],
    paramVersion: string,
    payload: Record<string, unknown>,
    parents: string[],
  ): ProvenanceEvent {
    const seq = state.events.length;
    const prevHash = state.events.length ? state.events[state.events.length - 1]!.selfHash : '';
    const event = makeEvent({
      seq,
      branchId: state.headBranchId,
      type,
      paramVersion,
      payload,
      parents,
      prevHash,
      timestamp: now(),
    });
    state.events.push(event);
    return event;
  }

  persist(state: ProjectState) {
    const json = serializeState(state);
    this.store.saveProjectState(state.projectId, state.name, state.createdAt, json);
    // 事件也逐条落 events 表，用于链校验与半写恢复测试。
    for (const e of state.events) {
      const existing = this.store.listEvents(state.projectId).length;
      if (e.seq >= existing) {
        const token = `tok-${e.seq}`;
        this.store.stageEvent(state.projectId, token, JSON.stringify(serializeEvent(e)));
        this.store.commitEvent(
          state.projectId,
          e.seq,
          e.eventId,
          e.branchId,
          JSON.stringify(serializeEvent(e)),
          e.selfHash,
          e.prevHash,
          token,
        );
      }
    }
  }

  getStore(): GelStore {
    return this.store;
  }
}

/* ---------------- 序列化（Uint8Array <-> base64） ---------------- */

export function serializeImage(image: ImageMaterial) {
  return {
    materialId: image.materialId,
    kind: image.kind,
    width: image.width,
    height: image.height,
    orientation: image.orientation,
    exposure: image.exposure,
    origin: image.origin,
    grayscaleBase64: Buffer.from(image.grayscale).toString('base64'),
  };
}

export function deserializeImage(json: ReturnType<typeof serializeImage>): ImageMaterial {
  return {
    materialId: json.materialId,
    kind: 'raw-gel-image',
    width: json.width,
    height: json.height,
    grayscale: new Uint8Array(Buffer.from(json.grayscaleBase64, 'base64')),
    orientation: json.orientation,
    exposure: json.exposure,
    origin: json.origin,
  };
}

function serializeEvent(e: ProvenanceEvent) {
  return { ...e };
}

export function serializeState(state: ProjectState): string {
  const materials: Record<string, unknown> = {};
  for (const [id, mat] of Object.entries(state.materials)) {
    materials[id] = mat.kind === 'raw-gel-image' ? serializeImage(mat as ImageMaterial) : mat;
  }
  return canonicalJson({
    projectId: state.projectId,
    name: state.name,
    createdAt: state.createdAt,
    materials,
    materialBindings: state.materialBindings,
    events: state.events,
    branches: state.branchOrder.map((id) => state.branches.get(id)!),
    branchOrder: state.branchOrder,
    headBranchId: state.headBranchId,
  });
}

export function deserializeState(json: string, store: GelStore, projectId: string): ProjectState {
  const data = JSON.parse(json) as {
    projectId: string;
    name: string;
    createdAt: string;
    materials: Record<string, any>;
    materialBindings: ProjectState['materialBindings'];
    events: ProvenanceEvent[];
    branches: any[];
    branchOrder: string[];
    headBranchId: string;
  };
  const state = emptyProject(data.projectId, data.name, data.createdAt);
  state.materialBindings = data.materialBindings;
  state.headBranchId = data.headBranchId;
  state.branchOrder = data.branchOrder;
  state.branches = new Map();
  for (const [id, raw] of Object.entries(data.materials)) {
    state.materials[id] = raw.kind === 'raw-gel-image' ? deserializeImage(raw) : (raw as LadderMaterial);
  }
  // 分支中的 Uint8Array 无；直接恢复结构。
  for (const b of data.branches) {
    state.branches.set(b.branchId, b);
  }
  state.events = data.events;
  void store;
  void projectId;
  void hashEvent;
  void sha256Hex;
  return state;
}
