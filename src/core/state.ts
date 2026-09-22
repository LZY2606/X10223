/**
 * 事件溯源状态：从 append-only 事件重放出某一分支在任一事件序号时的可见结论。
 * 回到任意旧事件时恢复当时的依赖版本与结果引用，绝不用最新计算覆盖历史。
 */
import type {
  BandCenterRevision,
  BranchSpec,
  ComputeResult,
  DecisionRecord,
  EventRecord,
  LaneGeometryRevision,
  Material,
  ParentRef
} from './types.js';

export interface ProjectState {
  projectId: string;
  name: string;
  branches: Map<string, BranchSpec>;
  materials: Map<string, Material>;
  lanes: Map<string, LaneGeometryRevision>;
  bands: Map<string, BandCenterRevision>;
  /** 每个分支头部引用的结果 id（历史引用保留在事件本身） */
  headResultByBranch: Map<string, string | null>;
  decisions: DecisionRecord[];
  /** 所有已产生结果的 id（结果实体由结果库保存，永不就地覆盖） */
  resultIds: Set<string>;
  lastSeq: number;
}

export function emptyState(projectId: string, name: string): ProjectState {
  return {
    projectId,
    name,
    branches: new Map(),
    materials: new Map(),
    lanes: new Map(),
    bands: new Map(),
    headResultByBranch: new Map(),
    decisions: [],
    resultIds: new Set(),
    lastSeq: 0
  };
}

interface RegisteredPayload {
  material?: Material;
  lane?: LaneGeometryRevision;
  band?: BandCenterRevision;
  branch?: BranchSpec;
  result?: ComputeResult;
  decision?: DecisionRecord;
}

export function applyEvent(state: ProjectState, ev: EventRecord): void {
  state.lastSeq = Math.max(state.lastSeq, ev.seq);
  switch (ev.type) {
    case 'project.created': {
      const p = ev.payload as { name: string; mainBranchId: string };
      state.name = p.name ?? state.name;
      if (!state.branches.has(ev.branchId)) {
        state.branches.set(ev.branchId, {
          id: ev.branchId,
          name: 'main',
          parentBranchId: null,
          forkSeq: 0,
          purpose: 'main',
          changedDirectSource: null
        });
        state.headResultByBranch.set(ev.branchId, null);
      }
      break;
    }
    case 'branch.created': {
      const b = (ev.payload as RegisteredPayload).branch!;
      if (!state.branches.has(b.id)) {
        state.branches.set(b.id, b);
        state.headResultByBranch.set(b.id, state.headResultByBranch.get(b.parentBranchId ?? '') ?? null);
      }
      break;
    }
    case 'material.registered': {
      const m = (ev.payload as RegisteredPayload).material!;
      state.materials.set(`${m.identity}@r${m.revision}`, m);
      break;
    }
    case 'auto.detected':
    case 'manual.override': {
      const p = ev.payload as RegisteredPayload;
      if (p.lane) state.lanes.set(`${p.lane.identity}@r${p.lane.revision}`, p.lane);
      if (p.band) state.bands.set(`${p.band.identity}@r${p.band.revision}`, p.band);
      break;
    }
    case 'compute.completed': {
      const r = (ev.payload as RegisteredPayload).result!;
      state.resultIds.add(r.id);
      state.headResultByBranch.set(ev.branchId, r.id);
      break;
    }
    case 'compute.failed':
    case 'export.recorded':
    case 'import.recorded':
      break;
    case 'decision.recorded': {
      const d = (ev.payload as { decision: DecisionRecord }).decision;
      state.decisions = [...state.decisions.filter((x) => x.id !== d.id), d];
      break;
    }
  }
}

/** 分支祖先链（含自身），forkSeq 是该分支创建时的全局事件序号 */
function ancestorChain(
  branches: Map<string, BranchSpec>,
  branchId: string
): { id: string; forkSeq: number }[] {
  const chain: { id: string; forkSeq: number }[] = [];
  let cur: BranchSpec | undefined = branches.get(branchId);
  const guard = new Set<string>();
  while (cur && !guard.has(cur.id)) {
    chain.push({ id: cur.id, forkSeq: cur.forkSeq });
    guard.add(cur.id);
    cur = cur.parentBranchId ? branches.get(cur.parentBranchId) : undefined;
  }
  return chain;
}

/** 事件在目标分支上是否可见（需要分支事件先注册，故 replay 分两遍） */
function visible(branches: Map<string, BranchSpec>, target: string, ev: EventRecord): boolean {
  if (ev.type === 'project.created' || ev.type === 'branch.created') return true;
  for (const a of ancestorChain(branches, target)) {
    if (ev.branchId === a.id) return ev.seq <= a.forkSeq || ev.branchId === target;
  }
  return false;
}

/**
 * 从事件流重放：
 *  - 第一遍注册全部分支（branch.created 不携带业务状态）；
 *  - 第二遍按祖先链与 forkSeq 过滤，使目标分支只看到 fork 前父链事件 + 自身事件；
 *  - afterSeq 截断以回到任意历史时刻。
 */
export function replay(
  events: EventRecord[],
  projectId: string,
  name: string,
  opts: { branchId?: string; afterSeq?: number } = {}
): ProjectState {
  const state = emptyState(projectId, name);
  const sorted = [...events].sort((a, b) => a.seq - b.seq);
  for (const ev of sorted) if (ev.type === 'branch.created') applyEvent(state, ev);
  for (const ev of sorted) {
    if (opts.afterSeq !== undefined && ev.seq > opts.afterSeq) break;
    if (ev.type === 'branch.created') continue;
    if (opts.branchId && !visible(state.branches, opts.branchId, ev)) continue;
    applyEvent(state, ev);
  }
  return state;
}

function latestOf<T extends { revision: number }>(vals: T[]): T | undefined {
  return vals.sort((a, b) => b.revision - a.revision)[0];
}

/** 取某身份的最新已重放版本 */
export function latestMaterial(state: ProjectState, identity: string) {
  return latestOf([...state.materials.values()].filter((m) => m.identity === identity));
}
export function latestLane(state: ProjectState, identity: string) {
  return latestOf([...state.lanes.values()].filter((l) => l.identity === identity));
}
export function latestBand(state: ProjectState, identity: string) {
  return latestOf([...state.bands.values()].filter((b) => b.identity === identity));
}

/**
 * 局部失效：把结果的父级依赖与当前最新版本比对，只返回真正变化的父级。
 * 未变化的依赖结果仍有效 —— “修订后局部失效”的影响被限制在正确范围。
 */
export function changedParents(
  result: ComputeResult,
  current: ProjectState
): { changed: ParentRef[]; unaffectedCount: number } {
  const changed: ParentRef[] = [];
  let unaffected = 0;
  for (const parent of result.parents) {
    let curRev: number | undefined;
    if (parent.kind === 'material') curRev = latestMaterial(current, parent.identity)?.revision;
    else if (parent.kind === 'lane') curRev = latestLane(current, parent.identity)?.revision;
    else if (parent.kind === 'band') curRev = latestBand(current, parent.identity)?.revision;
    else if (parent.kind === 'rule') curRev = undefined;

    if (parent.kind === 'rule') {
      if (parent.identity !== result.ruleVersion) changed.push(parent);
      else unaffected++;
    } else if (curRev === undefined) {
      // 父材料在当前分支不可见：视为影响（如分支切换）
      changed.push(parent);
    } else if (curRev !== parent.revision) {
      changed.push(parent);
    } else {
      unaffected++;
    }
  }
  return { changed, unaffectedCount: unaffected };
}
