import type {
  BranchInfo,
  GelEvent,
  Material,
  ParamSet,
  DecisionVerdict,
  UnitMass
} from './types';

/**
 * 纯函数状态投影：给定一个分支上的有序事件，重建该分支在事件序列末端的
 * 材料视图、参数版本与人工决定。回到任意旧事件（截断事件列表）即可恢复
 * 当时的依赖版本与可见结论——计算结果不覆盖历史。
 */

export interface ProjectState {
  projectId: string;
  materials: Map<string, Material>;
  /** kind -> 当前生效材料 id（含修订链 latest） */
  latestByKind: Map<string, string>;
  /** lane/band 这类多样本材料：imageId -> 列表 */
  lanes: Material[];
  bands: Material[];
  params: ParamSet[];
  decisions: Map<string, { eventId: string; verdict: DecisionVerdict; chosen: chosenType }>;
  branches: Map<string, BranchInfo>;
}

type chosenType =
  | { kind: 'point'; mass: number; unit: UnitMass }
  | { kind: 'interval'; low: number; high: number; unit: UnitMass }
  | null;

export function emptyState(projectId: string): ProjectState {
  return {
    projectId,
    materials: new Map(),
    latestByKind: new Map(),
    lanes: [],
    bands: [],
    params: [],
    decisions: new Map(),
    branches: new Map()
  };
}

export function applyEvent(state: ProjectState, event: GelEvent): void {
  switch (event.type) {
    case 'material.imported':
    case 'material.revised': {
      const material = (event.payload as { material: Material }).material;
      state.materials.set(material.id, material);
      if (material.kind === 'lane' || material.kind === 'band') {
        replaceInList(state, material);
      } else {
        state.latestByKind.set(singleKey(material), material.id);
      }
      break;
    }
    case 'param.revised': {
      const param = (event.payload as { param: ParamSet }).param;
      const idx = state.params.findIndex((p) => p.version === param.version);
      if (idx >= 0) state.params[idx] = param;
      else state.params.push(param);
      state.params.sort((a, b) => a.version - b.version);
      break;
    }
    case 'decision.accepted':
    case 'decision.rejected':
    case 'decision.conflict': {
      const payload = event.payload as {
        resultId: string;
        verdict: DecisionVerdict;
        chosen: chosenType;
      };
      state.decisions.set(payload.resultId, {
        eventId: event.id,
        verdict: payload.verdict,
        chosen: payload.chosen
      });
      break;
    }
    case 'branch.created': {
      const branch = (event.payload as { branch: BranchInfo }).branch;
      state.branches.set(branch.id, branch);
      break;
    }
    default:
      break;
  }
}

function replaceInList(state: ProjectState, material: Material): void {
  const list = material.kind === 'lane' ? state.lanes : state.bands;
  const idx = list.findIndex((m) => m.id === material.id);
  if (idx >= 0) list[idx] = material;
  else list.push(material);
  list.sort((a, b) => {
    if (a.kind === 'lane' && b.kind === 'lane') return a.laneIndex - b.laneIndex;
    if (a.kind === 'band' && b.kind === 'band') {
      const laneCmp = a.laneId.localeCompare(b.laneId);
      return laneCmp !== 0 ? laneCmp : a.center.y - b.center.y;
    }
    return 0;
  });
}

function singleKey(material: Material): string {
  if (material.kind === 'orientation' || material.kind === 'exposure' || material.kind === 'ladderNominal') {
    return `${material.kind}:${material.imageId}`;
  }
  return material.kind;
}

export function replay(
  projectId: string,
  events: GelEvent[],
  uptoEventId?: string
): { state: ProjectState; applied: GelEvent[] } {
  const state = emptyState(projectId);
  const ordered = [...events].sort((a, b) => a.seq - b.seq);
  const applied: GelEvent[] = [];
  for (const event of ordered) {
    if (event.projectId !== projectId) continue;
    applyEvent(state, event);
    applied.push(event);
    if (uptoEventId && event.id === uptoEventId) break;
  }
  return { state, applied };
}

export function currentParams(state: ProjectState): ParamSet | null {
  return state.params[state.params.length - 1] ?? null;
}

export function singleMaterial<T extends Material>(state: ProjectState, kind: string, imageId?: string): T | null {
  const key = imageId ? `${kind}:${imageId}` : kind;
  const id = state.latestByKind.get(key);
  return (id ? (state.materials.get(id) as T) : null) ?? null;
}

/** 取材料的完整修订链（首版 -> 当前） */
export function revisionChain(state: ProjectState, materialId: string): Material[] {
  const chain: Material[] = [];
  let cur: Material | undefined = state.materials.get(materialId);
  while (cur) {
    chain.unshift(cur);
    cur = cur.supersedes ? state.materials.get(cur.supersedes) : undefined;
  }
  return chain;
}
