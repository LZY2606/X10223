/**
 * 应用服务：业务规则在服务端（可被测试直接调用，不只藏在浏览器）。
 * 负责：项目装载/删除、计算入库、修订与决定（产生新事件）、分支、导出/导入往返、
 * 半写恢复，以及三类失败的区分。
 */
import Database from 'better-sqlite3';
import {
  beginIntent,
  clearIntent,
  ProjectStore,
  recoverInterrupted
} from './db.js';
import { runInference, DEFAULT_BUDGET, type EngineParams } from '../core/engine.js';
import type {
  BandCenterRevision,
  ComputeResult,
  CounterexampleEntry,
  DecisionRecord,
  EventRecord,
  EventType,
  FailureClass,
  LaneGeometryRevision,
  Material,
  ParentRef,
  RawImageMaterial
} from '../core/types.js';
import { replay } from '../core/state.js';
import { sha256Bytes, sha256Of, stableStringify } from '../core/hash.js';
import { buildBlueprint, type ProjectBlueprint } from '../core/casepack/builder.js';
import type { ScenarioKind } from '../core/casepack/scenarios.js';

export interface ExportBundle {
  format: 'gel-ladder-workbench/1';
  projectId: string;
  name: string;
  mainBranchId: string;
  currentImageIdentity: string;
  ladderLaneIdentity: string;
  laneLabels: unknown;
  counterexamples: CounterexampleEntry[];
  branches: unknown[];
  events: EventRecord[];
  materials: Material[];
  lanes: LaneGeometryRevision[];
  bands: BandCenterRevision[];
  results: ComputeResult[];
  blobs: { blobId: string; sha256: string; mediaType: string; base64: string }[];
  createdAt: string;
}

export interface ServiceResponse<T = unknown> {
  status: 'ok' | FailureClass;
  data?: T;
  diagnostic?: unknown;
  diagnostics?: unknown[];
}

export class GelService {
  readonly store: ProjectStore;
  constructor(private readonly db: Database.Database) {
    this.store = new ProjectStore(db);
  }

  /** 由案例包蓝图装载项目（幂等：已存在则直接返回） */
  loadScenario(projectId: string, kind: ScenarioKind, force = false): ProjectBlueprint {
    if (this.store.projectExists(projectId)) {
      if (!force) return this.blueprintOf(projectId);
      this.store.deleteProject(projectId);
    }
    const bp = buildBlueprint(projectId, kind);
    const tx = this.db.transaction(() => {
      this.store.createProject({
        id: bp.projectId,
        name: bp.name,
        main_branch_id: bp.mainBranchId,
        current_image_identity: bp.currentImageIdentity,
        ladder_lane_identity: bp.ladderLaneIdentity,
        lane_labels: bp.laneLabels as never,
        created_at: new Date(Date.UTC(2026, 8, 19, 3, 20, 0)).toISOString()
      });
      this.store.addBranch(projectId, {
        id: bp.mainBranchId,
        name: 'main',
        parentBranchId: null,
        forkSeq: 0,
        purpose: 'main',
        changedDirectSource: null
      });
      for (const [blobId, bytes] of bp.blobs) {
        this.store.putBlob(projectId, blobId, sha256Bytes(bytes), bytes);
      }
      for (const m of bp.materials) this.store.putMaterial(projectId, m);
      for (const l of bp.lanes) this.store.putLane(projectId, l);
      for (const b of bp.bands) this.store.putBand(projectId, b);
      for (const ev of bp.events) this.store.appendEvent(projectId, ev);
    });
    tx();
    return bp;
  }

  private blueprintOf(projectId: string): ProjectBlueprint {
    const row = this.store.getProject(projectId)!;
    return {
      projectId,
      name: row.name,
      mainBranchId: row.main_branch_id,
      events: this.store.getEvents(projectId),
      materials: this.store.getAllMaterials(projectId),
      lanes: this.store.getAllLanes(projectId),
      bands: this.store.getAllBands(projectId),
      blobs: new Map(),
      currentImageIdentity: row.current_image_identity,
      ladderLaneIdentity: row.ladder_lane_identity,
      laneLabels: JSON.parse(row.lane_labels)
    };
  }

  /** 取项目当前视图状态（指定分支/历史序号可回放） */
  viewState(projectId: string, branchId?: string, afterSeq?: number) {
    const row = this.store.getProject(projectId);
    if (!row) throw new NotFoundError(`project ${projectId} not found`);
    const events = this.store.getEvents(projectId);
    return replay(events, projectId, row.name, { branchId, afterSeq });
  }

  /** 取分支 head 结果；历史结果可用 getResult */
  headResult(projectId: string, branchId: string): ComputeResult | undefined {
    const state = this.viewState(projectId, branchId);
    const id = state.headResultByBranch.get(branchId);
    return id ? this.store.getResult(projectId, id) : undefined;
  }

  getResult(projectId: string, resultId: string): ComputeResult | undefined {
    return this.store.getResult(projectId, resultId);
  }

  /** 在指定分支/历史时刻运行推断，入库并追加计算事件（绝不覆盖历史结果） */
  compute(
    projectId: string,
    opts: {
      branchId?: string;
      afterSeq?: number;
      params?: Partial<EngineParams>;
      imageIdentity?: string;
      actor?: EventRecord['actor'];
    } = {}
  ): ServiceResponse<{ resultId: string }> {
    const row = this.store.getProject(projectId);
    if (!row) throw new NotFoundError(`project ${projectId} not found`);
    const branchId = opts.branchId ?? row.main_branch_id;
    const state = this.viewState(projectId, branchId, opts.afterSeq);
    const imageIdentity = opts.imageIdentity ?? this.imageForState(projectId, branchId, opts.afterSeq);
    const image = [...state.materials.values()].find(
      (m) => m.identity === imageIdentity
    ) as RawImageMaterial | undefined;
    if (!image) {
      return {
        status: 'semantic-unsolvable',
        diagnostics: [
          {
            code: 'MISSING_IMAGE',
            severity: 'error',
            message: '该分支/时刻没有可用图像材料',
            location: { field: 'imageIdentity' },
            failureClass: 'semantic-unsolvable'
          }
        ]
      };
    }
    const blob = this.store.getBlobBySha(projectId, image.sha256);
    if (!blob) {
      return {
        status: 'format-corrupt',
        diagnostic: {
          code: 'BLOB_MISSING',
          severity: 'error',
          message: '图像字节缺失，无法重放计算',
          failureClass: 'format-corrupt'
        }
      };
    }
    const outcome = runInference({
      projectId,
      branchId,
      imageIdentity,
      imageBytes: blob.bytes,
      state,
      ladderLaneIdentity: row.ladder_lane_identity,
      params: opts.params
    });

    if (outcome.status === 'format-corrupt') {
      this.appendSystemEvent(projectId, branchId, 'compute.failed', {
        reason: outcome.diagnostic
      }, 'format-corrupt');
      return { status: 'format-corrupt', diagnostic: outcome.diagnostic };
    }
    if (outcome.status === 'resource-exhausted') {
      this.appendSystemEvent(projectId, branchId, 'compute.failed', {
        reason: outcome.diagnostic,
        used: outcome.used ?? DEFAULT_BUDGET
      }, 'resource-exhausted');
      return { status: 'resource-exhausted', diagnostic: outcome.diagnostic };
    }

    const result = outcome.result!;
    this.store.putResult(projectId, result);
    this.appendSystemEvent(
      projectId,
      branchId,
      'compute.completed',
      { result },
      outcome.status === 'ok' ? 'ok' : 'semantic-unsolvable',
      result.id,
      result.parents,
      result.inputSummary,
      opts.actor ?? 'auto'
    );
    return {
      status: outcome.status,
      data: { resultId: result.id },
      diagnostics: outcome.diagnostics
    };
  }

  private imageForState(projectId: string, branchId: string, afterSeq?: number): string {
    const state = this.viewState(projectId, branchId, afterSeq);
    const row = this.store.getProject(projectId)!;
    const current = [...state.materials.values()]
      .filter((m) => m.kind === 'derivedImage' || m.kind === 'rawImage')
      .sort((a, b) => b.revision - a.revision)[0];
    return current?.identity ?? row.current_image_identity;
  }

  private appendSystemEvent(
    projectId: string,
    branchId: string,
    type: EventType,
    payload: unknown,
    outcomeClass: EventRecord['outcomeClass'],
    resultId: string | null = null,
    parents: ParentRef[] = [],
    inputSummary: Record<string, string> = {},
    actor: EventRecord['actor'] = 'system'
  ): EventRecord {
    const events = this.store.getEvents(projectId);
    const last = events.filter((e) => e.branchId === branchId).at(-1);
    const seq = this.store.nextSeq(projectId);
    const ev: EventRecord = {
      id: `ev-${String(seq).padStart(6, '0')}`,
      seq,
      projectId,
      branchId,
      parentEventId: last?.id ?? null,
      type,
      actor,
      payload,
      inputSummary,
      paramVersion: 'gel-rules-1.0.0',
      parents,
      resultId,
      outcomeClass
    };
    this.store.appendEvent(projectId, ev);
    return ev;
  }

  /** 人工修订泳道几何（新版本，身份不变；旧版本与结论保留） */
  reviseLane(
    projectId: string,
    branchId: string,
    next: Omit<LaneGeometryRevision, 'revision' | 'source'> & { source?: LaneGeometryRevision['source'] }
  ): EventRecord {
    const state = this.viewState(projectId, branchId);
    const prev = [...state.lanes.values()]
      .filter((l) => l.identity === next.identity)
      .sort((a, b) => b.revision - a.revision)[0];
    const rev: LaneGeometryRevision = {
      ...next,
      frame: next.frame,
      left: next.left,
      right: next.right,
      revision: (prev?.revision ?? 0) + 1,
      source: next.source ?? 'manual'
    };
    this.store.putLane(projectId, rev);
    return this.appendSystemEvent(
      projectId,
      branchId,
      'manual.override',
      { lane: rev },
      undefined,
      null,
      [{ kind: 'lane', identity: rev.identity, revision: rev.revision - 1 }],
      { lane: `${rev.identity}@r${rev.revision}` },
      'reviewer'
    );
  }

  /** 人工修订条带中心（产生 LOCAL_INVALIDATION_AFTER_REVISION 判断事件的入口） */
  reviseBand(
    projectId: string,
    branchId: string,
    next: Omit<BandCenterRevision, 'revision' | 'source'> & { source?: BandCenterRevision['source'] }
  ): EventRecord {
    const state = this.viewState(projectId, branchId);
    const prev = [...state.bands.values()]
      .filter((b) => b.identity === next.identity)
      .sort((a, b) => b.revision - a.revision)[0];
    const rev: BandCenterRevision = {
      ...next,
      revision: (prev?.revision ?? 0) + 1,
      source: next.source ?? 'manual'
    };
    this.store.putBand(projectId, rev);
    return this.appendSystemEvent(
      projectId,
      branchId,
      'manual.override',
      { band: rev },
      undefined,
      null,
      [{ kind: 'band', identity: rev.identity, revision: rev.revision - 1 }],
      { band: `${rev.identity}@r${rev.revision}` },
      'reviewer'
    );
  }

  /** 接受 / 否定 / 参数调整 —— 都生成新事件，不改写历史 */
  recordDecision(
    projectId: string,
    branchId: string,
    decision: Omit<DecisionRecord, 'id'>
  ): EventRecord {
    const seq = this.store.nextSeq(projectId);
    const full: DecisionRecord = { ...decision, id: `dec-${projectId}-${seq}` };
    return this.appendSystemEvent(
      projectId,
      branchId,
      'decision.recorded',
      { decision: full },
      undefined,
      null,
      [{ kind: 'compute', identity: decision.fromResultId, revision: null }],
      { decisionTarget: decision.targetIdentity, status: decision.status },
      'reviewer'
    );
  }

  createBranch(
    projectId: string,
    spec: {
      id: string;
      name: string;
      purpose: 'main' | 'counterexample';
      changedDirectSource: string | null;
    }
  ): EventRecord {
    const state = this.viewState(projectId, this.store.getProject(projectId)!.main_branch_id);
    const forkSeq = state.lastSeq;
    const events = this.store.getEvents(projectId);
    const last = events.at(-1);
    const branch = {
      id: spec.id,
      name: spec.name,
      parentBranchId: this.store.getProject(projectId)!.main_branch_id,
      forkSeq,
      purpose: spec.purpose,
      changedDirectSource: spec.changedDirectSource
    };
    this.store.addBranch(projectId, branch);
    const seq = this.store.nextSeq(projectId);
    const ev: EventRecord = {
      id: `ev-${String(seq).padStart(6, '0')}`,
      seq,
      projectId,
      branchId: spec.id,
      parentEventId: last?.id ?? null,
      type: 'branch.created',
      actor: 'reviewer',
      payload: { branch },
      inputSummary: { forkSeq: String(forkSeq) },
      paramVersion: 'gel-rules-1.0.0',
      parents: [],
      resultId: null
    };
    this.store.appendEvent(projectId, ev);
    return ev;
  }

  setCounterexamples(projectId: string, entries: CounterexampleEntry[]): void {
    this.store.updateProjectMeta(projectId, { counterexamples: entries });
  }
  getCounterexamples(projectId: string): CounterexampleEntry[] {
    return JSON.parse(this.store.getProject(projectId)!.counterexamples);
  }

  listBranches(projectId: string) {
    return this.store.getBranches(projectId);
  }

  listEvents(projectId: string, branchId?: string) {
    const all = this.store.getEvents(projectId);
    if (!branchId) return all;
    const state = this.viewState(projectId, branchId);
    return all.filter((e) => {
      if (e.type === 'branch.created' || e.type === 'project.created') return true;
      // 与 replay 相同的可见性近似：祖先分支且 seq<=forkSeq，或本分支
      return this.eventBelongs(state, branchId, e);
    });
  }

  private eventBelongs(state: ReturnType<GelService['viewState']>, target: string, ev: EventRecord): boolean {
    const chain: { id: string; forkSeq: number }[] = [];
    let cur = state.branches.get(target);
    const guard = new Set<string>();
    while (cur && !guard.has(cur.id)) {
      chain.push({ id: cur.id, forkSeq: cur.forkSeq });
      guard.add(cur.id);
      cur = cur.parentBranchId ? state.branches.get(cur.parentBranchId) : undefined;
    }
    return chain.some((a) => ev.branchId === a.id && (ev.seq <= a.forkSeq || a.id === target));
  }

  deleteProject(projectId: string): void {
    this.store.deleteProject(projectId);
  }

  /** 半写恢复状态（启动时报告） */
  recoveryStatus() {
    return recoverInterrupted(this.db);
  }

  /** 导出：身份/顺序/分支/决定历史全部保留，字节以 base64 内联；整体确定序 */
  exportProject(projectId: string): ExportBundle {
    const row = this.store.getProject(projectId);
    if (!row) throw new NotFoundError(`project ${projectId} not found`);
    const events = this.store.getEvents(projectId);
    const resultRows = this.db
      .prepare('SELECT json FROM results WHERE project_id = ?')
      .all(projectId) as { json: string }[];
    const results = resultRows
      .map((r) => JSON.parse(r.json) as ComputeResult)
      .sort((a, b) => a.id.localeCompare(b.id));

    const materials = this.store.getAllMaterials(projectId);
    const imageMat = materials.filter((m) => m.kind === 'rawImage' || m.kind === 'derivedImage') as RawImageMaterial[];
    const blobs = imageMat
      .map((m) => {
        const b = this.store.getBlobBySha(projectId, m.sha256);
        if (!b) return null;
        return {
          blobId: b.blobId,
          sha256: m.sha256,
          mediaType: m.mediaType,
          base64: Buffer.from(b.bytes).toString('base64')
        };
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
      .sort((a, b) => a.sha256.localeCompare(b.sha256));

    const bundle: ExportBundle = {
      format: 'gel-ladder-workbench/1',
      projectId,
      name: row.name,
      mainBranchId: row.main_branch_id,
      currentImageIdentity: row.current_image_identity,
      ladderLaneIdentity: row.ladder_lane_identity,
      laneLabels: JSON.parse(row.lane_labels),
      counterexamples: JSON.parse(row.counterexamples),
      branches: this.store.getBranches(projectId).sort((a, b) => a.id.localeCompare(b.id)),
      events,
      materials: materials.sort((a, b) =>
        `${a.identity}@r${a.revision}`.localeCompare(`${b.identity}@r${b.revision}`)
      ),
      lanes: this.store.getAllLanes(projectId).sort((a, b) =>
        `${a.identity}@r${a.revision}`.localeCompare(`${b.identity}@r${b.revision}`)
      ),
      bands: this.store.getAllBands(projectId).sort((a, b) =>
        `${a.identity}@r${b.revision}`.localeCompare(`${b.identity}@r${b.revision}`)
      ),
      results,
      blobs,
      createdAt: new Date(Date.UTC(2026, 8, 23, 0, 0, 0)).toISOString()
    };
    this.appendSystemEvent(projectId, row.main_branch_id, 'export.recorded', {
      format: bundle.format,
      eventCount: bundle.events.length,
      resultCount: bundle.results.length,
      bundleSha: sha256Of(stripBase64(bundle)).slice(0, 16)
    }, 'ok');
    return bundle;
  }

  /**
   * 导入：
   *  - 先全量校验（格式损坏 -> format-corrupt，不写任何业务表）；
   *  - journal 登记意图 -> 单事务写入 -> 清除意图；
   *  - simulateCrashAfterIntent=true 时在登记后、提交前抛错，用于半写恢复验收；
   *  - 身份/顺序/分支/决定历史原样保留。
   */
  importProject(bundle: unknown, opts: { targetId?: string; simulateCrashAfterIntent?: boolean } = {}): ServiceResponse<{
    projectId: string;
  }> {
    const validation = validateBundle(bundle);
    if (validation.status !== 'ok') return validation as ServiceResponse<{ projectId: string }>;
    const b = bundle as ExportBundle;
    const projectId = opts.targetId ?? b.projectId;

    beginIntent(this.db, 'import', { projectId, events: b.events.length });
    if (opts.simulateCrashAfterIntent) {
      const err = new Error('simulated crash after import intent (half-write)') as Error & {
        simulatedCrash: true;
      };
      err.simulatedCrash = true;
      throw err;
    }

    const tx = this.db.transaction(() => {
      this.store.deleteProject(projectId);
      this.store.createProject({
        id: projectId,
        name: b.name,
        main_branch_id: b.mainBranchId,
        current_image_identity: b.currentImageIdentity,
        ladder_lane_identity: b.ladderLaneIdentity,
        lane_labels: b.laneLabels as never,
        counterexamples: JSON.stringify(b.counterexamples ?? []) as never,
        created_at: b.createdAt
      });
      for (const branch of b.branches) this.store.addBranch(projectId, branch as never);
      for (const blob of b.blobs) {
        const bytes = new Uint8Array(Buffer.from(blob.base64, 'base64'));
        if (sha256Bytes(bytes) !== blob.sha256) {
          throw new BundleError('BLOB_HASH_MISMATCH', `blob ${blob.blobId} 校验失败`);
        }
        this.store.putBlob(projectId, blob.blobId, blob.sha256, bytes);
      }
      for (const m of b.materials) this.store.putMaterial(projectId, m);
      for (const l of b.lanes) this.store.putLane(projectId, l);
      for (const band of b.bands) this.store.putBand(projectId, band);
      for (const r of b.results) this.store.putResult(projectId, r);
      for (const ev of b.events) this.store.appendEvent(projectId, ev);
      this.appendSystemEvent(projectId, b.mainBranchId, 'import.recorded', {
        format: b.format,
        eventCount: b.events.length,
        preservedIds: true
      }, 'ok');
    });
    tx();
    clearIntent(this.db);
    return { status: 'ok', data: { projectId } };
  }
}

export class NotFoundError extends Error {}
export class BundleError extends Error {
  constructor(
    public readonly code: string,
    message: string
  ) {
    super(message);
  }
}

function stripBase64(b: ExportBundle): unknown {
  return { ...b, blobs: b.blobs.map((x) => ({ ...x, base64: '' })) };
}

/** 导入校验：结构/哈希/顺序/引用一致性 —— 任何语义问题都是 format-corrupt 或 semantic-unsolvable */
function validateBundle(bundle: unknown): ServiceResponse {
  if (typeof bundle !== 'object' || bundle === null) {
    return corrupt('BUNDLE_NOT_OBJECT', '导入包不是 JSON 对象');
  }
  const b = bundle as Partial<ExportBundle>;
  if (b.format !== 'gel-ladder-workbench/1') {
    return corrupt('BUNDLE_FORMAT', `不支持的格式：${String(b.format)}`);
  }
  const must: (keyof ExportBundle)[] = [
    'projectId',
    'name',
    'mainBranchId',
    'events',
    'materials',
    'lanes',
    'bands',
    'results',
    'blobs',
    'branches'
  ];
  for (const k of must) {
    if (b[k] === undefined) return corrupt('BUNDLE_MISSING_FIELD', `导入包缺少字段 ${k}`);
  }
  if (!Array.isArray(b.events) || !Array.isArray(b.materials) || !Array.isArray(b.blobs)) {
    return corrupt('BUNDLE_BAD_SHAPE', 'events/materials/blobs 必须是数组');
  }
  // 事件 seq 连续且严格递增（顺序必须保持）
  let expected = 1;
  for (const ev of b.events as EventRecord[]) {
    if (typeof ev !== 'object' || ev.seq !== expected) {
      return corrupt('BUNDLE_EVENT_SEQ', `事件顺序在第 ${expected} 条处不连续`);
    }
    if (!ev.id || ev.branchId === undefined) {
      return corrupt('BUNDLE_EVENT_SHAPE', `第 ${expected} 条事件缺少 id/branchId`);
    }
    expected++;
  }
  // blob base64 合法性（哈希在事务内逐一校验，这里先保证可解码）
  for (const blob of b.blobs) {
    if (!/^[0-9a-f]{64}$/.test(blob.sha256)) {
      return corrupt('BLOB_SHA_SHAPE', `blob ${blob.blobId} sha256 形状非法`);
    }
    if (typeof blob.base64 !== 'string' || !isBase64(blob.base64)) {
      return corrupt('BLOB_BASE64', `blob ${blob.blobId} base64 损坏`);
    }
  }
  // 事件引用的分支必须存在
  const branchIds = new Set((b.branches as { id: string }[]).map((x) => x.id));
  for (const ev of b.events as EventRecord[]) {
    if (!branchIds.has(ev.branchId)) {
      return {
        status: 'semantic-unsolvable',
        diagnostics: [
          {
            code: 'BUNDLE_DANGLING_BRANCH',
            severity: 'error',
            message: `事件 ${ev.id} 引用了不存在的分支 ${ev.branchId}`,
            failureClass: 'semantic-unsolvable'
          }
        ]
      };
    }
  }
  return { status: 'ok' };
}

function corrupt(code: string, message: string): ServiceResponse {
  return {
    status: 'format-corrupt',
    diagnostic: { code, severity: 'error', message, failureClass: 'format-corrupt' }
  };
}

function isBase64(s: string): boolean {
  return /^[A-Za-z0-9+/]*={0,2}$/.test(s) && s.length % 4 === 0;
}
