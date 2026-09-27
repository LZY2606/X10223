import { stableDigest, sha256Text } from './hash.js';
import { detectBands, DEFAULT_DETECTION_PARAMS, toBandMaterial } from './detection.js';
import { calibrateLadder, DEFAULT_CALIBRATION_PARAMS } from './calibration.js';
import { inferMolecularWeights } from './inference.js';
import type {
  BandObservationMaterial,
  BranchCreatedEvent,
  ComputedEvent,
  ComputedResult,
  DecisionEvent,
  DomainValue,
  GelImageMaterial,
  InferenceResult,
  LadderMaterial,
  LaneSketchMaterial,
  Material,
  MwCandidate,
  ParameterName,
  ProjectEvent,
  ProjectState
} from './types.js';

export interface ParameterSet {
  'orientation-deg': number;
  'calibration-model': 'piecewise-linear-log';
  'saturation-threshold': number;
  'overlap-merge-gap-px': number;
  'ruler-valid-padding': number;
}

export const DEFAULT_PARAMETERS: ParameterSet = {
  'orientation-deg': 0,
  'calibration-model': 'piecewise-linear-log',
  'saturation-threshold': DEFAULT_DETECTION_PARAMS.saturationThreshold,
  'overlap-merge-gap-px': DEFAULT_DETECTION_PARAMS.overlapMergeGapPx,
  'ruler-valid-padding': DEFAULT_CALIBRATION_PARAMS.validPaddingPx
};

function materialLogicalId(m: Material): string {
  return m.id.split(':v')[0]!;
}
export function versionedId(logicalId: string, version: number): string {
  return `${logicalId}:v${version}`;
}

export function emptyState(projectId: string, mainBranch = 'main'): ProjectState {
  return {
    projectId,
    mainBranch,
    branches: [mainBranch],
    materials: [],
    materialHistory: {},
    events: [],
    branchHeads: { [mainBranch]: null },
    parameterVersions: (Object.keys(DEFAULT_PARAMETERS) as ParameterName[]).map((name) => ({
      name,
      version: 1,
      value: DEFAULT_PARAMETERS[name]
    })),
    computations: {}
  };
}

/** 应用单个事件到聚合状态（投影）。 */
export function applyEvent(state: ProjectState, ev: ProjectEvent): ProjectState {
  state.events.push(ev);
  if (!state.branches.includes(ev.branch)) {
    state.branches.push(ev.branch);
    state.branchHeads[ev.branch] = null;
  }
  state.branchHeads[ev.branch] = ev.id;

  if (ev.type === 'material-ingested') {
    const m = ev.material;
    const logical = materialLogicalId(m);
    const hist = state.materialHistory[logical] ?? [];
    hist.push(m);
    state.materialHistory[logical] = hist;
    state.materials = state.materials.filter((x) => materialLogicalId(x) !== logical);
    state.materials.push(m);
    // 源数据改动：把依赖该材料的旧计算结果标记为陈旧（局部失效），但不删除历史事件。
    if ((m.version ?? 1) > 1) invalidateForMaterial(state, logical);
  } else if (ev.type === 'parameter-revision') {
    const pv = state.parameterVersions.find((p) => p.name === ev.name)!;
    pv.value = ev.newValue;
    pv.version += 1;
    invalidateComputation(state, computationForParameter(ev.name));
  } else if (ev.type === 'computed') {
    state.computations[keyOf(ev.computation, laneOfResult(ev.result))] = ev.result;
  }
  return state;
}

function computationForParameter(name: ParameterName): string {
  if (name === 'orientation-deg' || name === 'saturation-threshold' || name === 'overlap-merge-gap-px') {
    return 'detect-bands';
  }
  return 'calibrate-ladder';
}

function invalidateForMaterial(state: ProjectState, logicalId: string): void {
  const kind = state.materialHistory[logicalId]?.[0]?.kind;
  if (kind === 'ladder-spec') invalidateComputation(state, 'calibrate-ladder');
  if (kind === 'band-observation' || kind === 'lane-sketch') invalidateComputation(state, 'detect-bands');
  invalidateComputation(state, 'infer-molecular-weight');
}

function invalidateComputation(state: ProjectState, computation: string): void {
  for (const key of Object.keys(state.computations)) {
    if (key.startsWith(computation)) {
      const r = state.computations[key]!;
      if (r.inference) r.inference.candidates.forEach((c) => (c.stale = true));
      if (r.calibration) {
        r.calibration.diagnostics.push({
          code: 'LOCAL_RULER_INVALIDATED',
          severity: 'warning',
          message: '局部依赖源数据已变更，该标尺版本已失效；历史事件保留旧结果，新结果以新版本重算'
        });
      }
      state.computations[`${key}::stale@${state.events.length + 1}`] = JSON.parse(JSON.stringify(r));
      delete state.computations[key];
    }
  }
}

function keyOf(computation: string, lane: string | null): string {
  return lane ? `${computation}:${lane}` : computation;
}
function laneOfResult(r: ComputedResult): string | null {
  return r.calibration?.laneId ?? r.inference?.laneId ?? null;
}

/** 重放到某个事件（含），得到当时的依赖版本与可见结论，而不是用最新结果覆盖历史。 */
export function replayUntil(
  projectId: string,
  events: ProjectEvent[],
  untilEventId: string | null,
  branch: string
): { state: ProjectState; event: ProjectEvent | null; index: number } {
  const state = emptyState(projectId);
  const branchEvents = branchAncestors(events, branch);
  let target: ProjectEvent | null = null;
  let index = -1;
  for (const ev of branchEvents) {
    applyEvent(state, ev);
    if (ev.id === untilEventId) {
      target = ev;
      index = state.events.length - 1;
      break;
    }
  }
  if (!untilEventId) {
    index = state.events.length - 1;
  }
  return { state, event: target, index };
}

/** 某分支上按依赖顺序的事件（main 为主干；其他分支从分叉点起）。 */
export function branchAncestors(events: ProjectEvent[], branch: string): ProjectEvent[] {
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  if (branch === 'main') return ordered.filter((e) => e.branch === 'main');
  const fork = ordered.find((e) => e.type === 'branch-created' && e.branch === branch);
  if (!fork) return ordered.filter((e) => e.branch === branch);
  const mainUpToFork = ordered.filter(
    (e) => e.branch === 'main' && e.seq <= fork.seq
  );
  const branchAfter = ordered.filter((e) => e.branch === branch);
  return [...mainUpToFork, ...branchAfter];
}

export function currentParameters(state: ProjectState): ParameterSet {
  const out = { ...DEFAULT_PARAMETERS };
  for (const pv of state.parameterVersions) {
    (out as Record<string, unknown>)[pv.name] = pv.value;
  }
  return out;
}

export function parameterVersion(state: ProjectState, name: ParameterName): number {
  return state.parameterVersions.find((p) => p.name === name)!.version;
}

// ---------- 工作流服务（业务规则不藏在浏览器；纯 TS 可直接测试） ----------

export class WorkflowService {
  readonly state: ProjectState;
  private clock: () => string;
  private actor: string;

  constructor(projectId: string, clock: () => string = () => new Date().toISOString(), actor = 'auto') {
    this.state = emptyState(projectId);
    this.clock = clock;
    this.actor = actor;
  }

  load(events: ProjectEvent[]): void {
    for (const ev of [...events].sort((a, b) => a.seq - b.seq)) applyEvent(this.state, ev);
  }

  private nextId(kind: string, digestInput: unknown): string {
    const seq = this.state.events.length + 1;
    return `evt-${kind}-${seq}-${stableDigest({ seq, kind, digestInput }).slice(0, 8)}`;
  }

  private push(ev: ProjectEvent, branch: string): ProjectEvent {
    this.applyBranch(branch);
    ev.seq = this.state.events.length + 1;
    ev.projectId = this.state.projectId;
    ev.branch = branch;
    ev.parentEventId = this.state.branchHeads[branch] ?? null;
    applyEvent(this.state, ev);
    return ev;
  }

  private applyBranch(branch: string): void {
    if (!this.state.branches.includes(branch)) this.state.branches.push(branch);
  }

  createBranch(branch: string, fromBranch = 'main', reason = ''): ProjectEvent {
    if (this.state.branches.includes(branch) && branch !== fromBranch) {
      throw new Error(`branch ${branch} exists`);
    }
    const ev: BranchCreatedEvent = {
      id: '',
      seq: 0,
      projectId: '',
      branch,
      parentEventId: null,
      timestamp: this.clock(),
      actor: 'auto',
      type: 'branch-created',
      fromBranch
    } as BranchCreatedEvent;
    ev.id = this.nextId('branch', { branch, reason });
    this.push(ev, 'main');
    this.state.branchHeads[branch] = this.state.branchHeads['main'] ?? null;
    return ev;
  }

  ingest(material: Material, branch = 'main'): ProjectEvent {
    const ev = {
      id: this.nextId('ingest', stableDigest(material)),
      seq: 0,
      projectId: '',
      branch,
      parentEventId: null,
      timestamp: this.clock(),
      actor: this.actor as ProjectEvent['actor'],
      type: 'material-ingested',
      material
    } as Extract<ProjectEvent, { type: 'material-ingested' }>;
    return this.push(ev, branch);
  }

  /** 源数据改动：生成新版本（直接来源只改一个），旧版本永久保留。 */
  reviseMaterial(next: Material, reason: string, branch = 'main'): ProjectEvent {
    const logical = materialLogicalId(next);
    const history = this.state.materialHistory[logical] ?? [];
    const prev = history[history.length - 1];
    const versioned: Material = {
      ...next,
      id: versionedId(logical, (prev?.version ?? 0) + 1),
      version: (prev?.version ?? 0) + 1,
      parentVersionId: prev?.id ?? null
    } as Material;
    const ev = {
      id: this.nextId('revise', { logical, reason, version: versioned.version }),
      seq: 0,
      projectId: '',
      branch,
      parentEventId: null,
      timestamp: this.clock(),
      actor: this.actor,
      type: 'material-ingested',
      material: versioned
    } as Extract<ProjectEvent, { type: 'material-ingested' }>;
    return this.push(ev, branch);
  }

  reviseParameter(name: ParameterName, newValue: unknown, reason: string, branch = 'main'): ProjectEvent {
    const old = currentParameters(this.state)[name];
    const ev = {
      id: this.nextId('param', { name, newValue }),
      seq: 0,
      projectId: '',
      branch,
      parentEventId: null,
      timestamp: this.clock(),
      actor: this.actor,
      type: 'parameter-revision',
      name,
      oldValue: old,
      newValue,
      reason
    } as Extract<ProjectEvent, { type: 'parameter-revision' }>;
    return this.push(ev, branch);
  }

  decide(
    targetCandidateId: string,
    action: DecisionEvent['action'],
    payload: DecisionEvent['payload'],
    branch = 'main'
  ): ProjectEvent {
    // 冲突人工决定：同一候选在同分支上已有矛盾动作 -> 记录 conflict，不静默覆盖。
    const prior = this.state.events
      .filter((e): e is DecisionEvent => e.type === 'decision' && e.branch === branch && e.targetCandidateId === targetCandidateId)
      .filter((e) => e.action === 'accept' || e.action === 'reject');
    const contradictory = prior.find((p) => (p.action === 'accept' && action === 'reject') || (p.action === 'reject' && action === 'accept'));
    const effectiveAction = contradictory ? 'conflict' : action;
    const ev = {
      id: this.nextId('decide', { targetCandidateId, action, payload }),
      seq: 0,
      projectId: '',
      branch,
      parentEventId: null,
      timestamp: this.clock(),
      actor: this.actor,
      type: 'decision',
      targetCandidateId,
      action: effectiveAction,
      payload: payload ? { ...payload, note: contradictory ? `${payload.note ?? ''} | 与决定 ${contradictory.id} 冲突，候选标记 conflicted`.trim() : payload.note } : payload
    } as DecisionEvent;
    this.push(ev, branch);
    this.applyDecisionToProjection(targetCandidateId, ev);
    return ev;
  }

  private applyDecisionToProjection(targetCandidateId: string, ev: DecisionEvent): void {
    for (const key of Object.keys(this.state.computations)) {
      const r = this.state.computations[key]!;
      if (!r.inference) continue;
      const c = r.inference.candidates.find((x) => x.id === targetCandidateId || x.alternatives.length > 0 && x.id === targetCandidateId);
      if (!c) continue;
      c.decidedBy = [...(c.decidedBy ?? []), ev.id];
      if (ev.action === 'accept') c.status = 'confirmed';
      if (ev.action === 'reject') c.status = 'rejected';
      if (ev.action === 'set-range' && ev.payload) {
        c.status = 'range';
        const mk = (v: number): DomainValue => ({ value: v, unit: c.mw?.unit ?? 'bp', raw: `${v} bp`, ref: c.mw?.ref });
        c.range = { lower: mk(ev.payload.lower!), upper: mk(ev.payload.upper!) };
      }
      if (ev.action === 'choose-candidate' && ev.payload?.chosenCandidateId) {
        const chosen = c.alternatives.find((a) => alternativeToken(c.bandId, a) === ev.payload!.chosenCandidateId);
        if (chosen) {
          c.mw = chosen.mw;
          c.segmentId = chosen.segmentId;
          c.ladderPointIds = chosen.ladderPointIds;
          c.status = 'confirmed';
        }
      }
      if (ev.action === 'conflict') c.status = 'conflicted';
    }
  }

  // ---------- 计算：输入摘要 + 参数版本 + 父级依赖 ----------

  private latest<T extends Material>(kind: T['kind'], predicate: (m: Material) => boolean = () => true): T | null {
    const found = this.state.materials.filter((m) => m.kind === kind && predicate(m));
    return (found[found.length - 1] as T) ?? null;
  }

  private recordComputed(
    computation: string,
    laneId: string,
    inputSummary: string,
    parents: string[],
    result: ComputedResult,
    branch: string
  ): ComputedEvent {
    const parameterVersionNow = this.state.parameterVersions.reduce((acc, p) => acc + p.version, 0);
    const ev = {
      id: this.nextId('computed', { computation, laneId, inputSummary }),
      seq: 0,
      projectId: '',
      branch,
      parentEventId: null,
      timestamp: this.clock(),
      actor: 'auto',
      type: 'computed',
      computation,
      inputSummary,
      parameterVersion: parameterVersionNow,
      parents,
      result
    } as ComputedEvent;
    this.push(ev, branch);
    return ev;
  }

  runDetection(imageId: string, laneId: string, branch = 'main'): ComputedEvent {
    const image = this.latest<GelImageMaterial>('gel-image', (m) => m.id.startsWith(imageId));
    const lane = this.latest<LaneSketchMaterial>('lane-sketch', (m) => materialLogicalId(m.id) === laneId || m.id === laneId);
    if (!image || !lane) throw new Error(`SEMANTIC_UNRESOLVABLE: missing image/lane for ${laneId}`);
    const params = currentParameters(this.state);
    const det = detectBands(image, lane, {
      ...DEFAULT_DETECTION_PARAMS,
      saturationThreshold: params['saturation-threshold'],
      overlapMergeGapPx: params['overlap-merge-gap-px']
    });
    // 为每个检测峰生成材料事件（像素级中心来源），再记录计算事件。
    const parents: string[] = [];
    const bands: BandObservationMaterial[] = det.peaks.map((peak, i) => {
      const mat = toBandMaterial(image, lane, peak, i, peak.overlapGroupId);
      const e = this.ingest(mat, branch);
      parents.push(e.id);
      return mat;
    });
    const summary = stableDigest({
      image: image.sha256,
      lane: { id: lane.id, v: lane.version, points: lane.centerline.length, hw: lane.halfWidthPx },
      params: [params['saturation-threshold'], params['overlap-merge-gap-px'], params['orientation-deg']]
    });
    return this.recordComputed('detect-bands', laneId, summary, [image.id, lane.id, ...parents], {
      inference: { laneId, candidates: [], diagnostics: det.diagnostics }
    }, branch);
  }

  runCalibration(branch = 'main'): ComputedEvent {
    const ladder = this.latest<LadderMaterial>('ladder-spec');
    if (!ladder) throw new Error('SEMANTIC_UNRESOLVABLE: no ladder');
    const lane = this.latest<LaneSketchMaterial>('lane-sketch', (m) => materialLogicalId(m.id) === ladder.laneId || m.id === ladder.laneId || m.isLadderLane);
    if (!lane) throw new Error('SEMANTIC_UNRESOLVABLE: no ladder lane');
    const bands = this.state.materials.filter(
      (m): m is BandObservationMaterial => m.kind === 'band-observation' && materialLogicalId(m.laneId) === materialLogicalId(lane.id)
    );
    const params = currentParameters(this.state);
    const result = calibrateLadder(ladder, bands, lane, {
      ...DEFAULT_CALIBRATION_PARAMS,
      validPaddingPx: params['ruler-valid-padding']
    });
    const summary = stableDigest({
      ladder: ladder.id,
      v: ladder.version,
      bands: ladder.bands.map((b) => [b.nominal.raw, b.observed]),
      bandMats: bands.map((b) => b.id),
      params: [params['ruler-valid-padding'], params['calibration-model']]
    });
    return this.recordComputed('calibrate-ladder', lane.id, summary,
      [ladder.id, lane.id, ...bands.map((b) => b.id)], { calibration: result }, branch);
  }

  runInference(laneId: string, branch = 'main'): ComputedEvent {
    const calEvent = [...this.state.events].reverse().find(
      (e): e is ComputedEvent => e.type === 'computed' && e.computation === 'calibrate-ladder' && e.result.calibration
    );
    if (!calEvent) throw new Error('SEMANTIC_UNRESOLVABLE: calibrate before inference');
    const cal = calEvent.result.calibration!;
    const bands = this.state.materials.filter(
      (m): m is BandObservationMaterial => m.kind === 'band-observation' && materialLogicalId(m.laneId) === laneId
    );
    const result: InferenceResult = inferMolecularWeights(laneId, bands, cal);
    // 把分支上已有的人工决定叠加到新结果（历史决定仍在事件里）。
    for (const c of result.candidates) {
      const decs = this.state.events.filter(
        (e): e is DecisionEvent => e.type === 'decision' && e.branch === branch && e.targetCandidateId === c.id
      );
      for (const d of decs) this.replayDecision(c, d);
    }
    const summary = stableDigest({
      laneId,
      cal: calEvent.inputSummary,
      bands: bands.map((b) => b.id),
      at: bands.map((b) => [b.id, b.arcLength?.value, b.saturated, b.smeared, b.overlapGroupId])
    });
    return this.recordComputed('infer-molecular-weight', laneId, summary,
      [calEvent.id, ...bands.map((b) => b.id)], { inference: result }, branch);
  }

  private replayDecision(c: MwCandidate, d: DecisionEvent): void {
    c.decidedBy = [...(c.decidedBy ?? []), d.id];
    if (d.action === 'accept') c.status = 'confirmed';
    if (d.action === 'reject') c.status = 'rejected';
    if (d.action === 'conflict') c.status = 'conflicted';
    if (d.action === 'set-range' && d.payload) {
      c.status = 'range';
      const mk = (v: number): DomainValue => ({ value: v, unit: c.mw?.unit ?? 'bp', raw: `${v} bp` });
      c.range = { lower: mk(d.payload.lower!), upper: mk(d.payload.upper!) };
    }
    if (d.action === 'choose-candidate' && d.payload?.chosenCandidateId) {
      const chosen = c.alternatives.find((a) => alternativeToken(c.bandId, a) === d.payload!.chosenCandidateId);
      if (chosen) {
        c.mw = chosen.mw;
        c.segmentId = chosen.segmentId;
        c.ladderPointIds = chosen.ladderPointIds;
        c.status = 'confirmed';
      }
    }
  }

  /** 证据回溯：给定候选 id，返回 ladder 点与插值段、材料/事件来源。 */
  provenance(candidateId: string, branch = 'main'): {
    candidate: MwCandidate | null;
    segments: ComputedResult['calibration'] extends infer _ ? unknown : never;
  } | null {
    const inf = Object.values(this.state.computations).find((r) => r.inference?.candidates.some((c) => c.id === candidateId));
    void branch;
    if (!inf?.inference) return null;
    const candidate = inf.inference.candidates.find((c) => c.id === candidateId) ?? null;
    const cal = Object.values(this.state.computations).map((r) => r.calibration).find(Boolean) ?? null;
    return { candidate, segments: cal } as never;
  }
}

export function alternativeToken(
  bandId: string,
  alt: { mw: DomainValue; segmentId: string | null }
): string {
  return stableDigest({ bandId, mw: alt.mw.raw, seg: alt.segmentId }).slice(0, 12);
}

// 事件 id 使用事件内容哈希；这里额外保证跨导入稳定（seq 也参与，但 seq 由事件顺序决定）。
export function deterministicEventId(kind: string, body: unknown): string {
  return `evt-${kind}-${sha256Text(JSON.stringify(body)).slice(0, 12)}`;
}
