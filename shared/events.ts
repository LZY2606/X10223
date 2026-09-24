/**
 * 事件溯源重放：事件构成一棵 DAG（parentId），每个事件 = 一个可回到的历史节点。
 * 回到任意旧事件时，从根重放到该节点恢复当时的依赖版本与可见结论，
 * 绝不拿最新计算覆盖历史。
 *
 * 稳定身份：事件 id = 内容哈希（同序列重放 -> 同 id、同顺序）。
 */
import { hashJson, shortId } from './hash';
import { derive, type MaterialState } from './calibration';
import type {
  Decision,
  Derivation,
  DerivationRecorded,
  Event,
  Material,
  MaterialAmended,
  MaterialAdded,
  ParamsSet,
  ProjectCreated,
  RuleParams
} from './types';
import { DEFAULT_RULE_PARAMS } from './types';

export interface ProjectNode {
  event: Event;
  depth: number;
  /** 截至此事件的材料快照（含修订，amendment 替代同 kind 活动版本）。 */
  materials: MaterialState;
  params: RuleParams;
  paramsHash: string;
  decisions: Decision[];
  /** 该节点若为 derivationRecorded，给出派生结果。 */
  derivation: Derivation | null;
  /** 仍未消解的冲突（同对象互相矛盾的人工决定）。 */
  conflicts: ConflictState[];
}

export interface ConflictState {
  targetId: string;
  decisionIds: string[];
  message: string;
}

export interface ProjectState {
  projectId: string;
  name: string;
  createdAt: string;
  nodes: ProjectNode[];
  byId: Map<string, ProjectNode>;
  children: Map<string, string[]>;
  headIds: string[];
}

export function eventDigest(event: Omit<Event, 'id'>): string {
  return hashJson(event);
}

export function computeEventId(event: Omit<Event, 'id'>): string {
  return shortId(eventDigest(event), 'evt');
}

function emptyMaterials(): MaterialState {
  return { bandMarks: [] };
}

function cloneMaterials(ms: MaterialState): MaterialState {
  return {
    imageId: ms.imageId,
    orientation: ms.orientation,
    exposure: ms.exposure,
    ladder: ms.ladder,
    laneMap: ms.laneMap,
    bandMarks: [...ms.bandMarks]
  };
}

function upsertMaterial(ms: MaterialState, material: Material, supersedesId?: string): void {
  switch (material.kind) {
    case 'image':
      ms.imageId = material.id;
      break;
    case 'orientation':
      ms.orientation = material;
      break;
    case 'exposure':
      ms.exposure = material;
      break;
    case 'ladderSpec':
      ms.ladder = material;
      break;
    case 'laneMap':
      ms.laneMap = material;
      break;
    case 'bandMarks': {
      const idx = ms.bandMarks.findIndex((b) => b.id === supersedesId);
      if (idx >= 0) ms.bandMarks[idx] = material;
      else ms.bandMarks.push(material);
      break;
    }
  }
}

/** 判定互相冲突：同一 targetId 上既有 accept 又有 reject。 */
function detectConflicts(decisions: Decision[]): ConflictState[] {
  const byTarget = new Map<string, Decision[]>();
  for (const d of decisions) {
    if (!byTarget.has(d.targetId)) byTarget.set(d.targetId, []);
    byTarget.get(d.targetId)!.push(d);
  }
  const out: ConflictState[] = [];
  for (const [targetId, ds] of byTarget) {
    const verbs = new Set(ds.map((d) => d.verb));
    if (verbs.has('accept') && verbs.has('reject')) {
      out.push({ targetId, decisionIds: ds.map((d) => d.id), message: `对象 ${targetId} 同时被接受与否定，等待裁决` });
    }
  }
  return out;
}

/**
 * 重放整棵事件树。事件按 (parent 链深度, 时间戳, 事件 id) 稳定排序；
 * 等价输入产生等价顺序。
 */
export function replay(events: Event[]): ProjectState {
  if (events.length === 0) throw new Error('空事件流');
  const sorted = topoSort(events);
  const root = sorted[0]!;
  if (root.kind !== 'projectCreated') throw new Error('首个事件必须是 projectCreated');

  const byId = new Map<string, ProjectNode>();
  const children = new Map<string, string[]>();
  const nodes: ProjectNode[] = [];

  for (const event of sorted) {
    const parent = event.parentId ? byId.get(event.parentId) : undefined;
    const materials = parent ? cloneMaterials(parent.materials) : emptyMaterials();
    const params = parent ? parent.params : DEFAULT_RULE_PARAMS;
    const paramsHash = parent ? parent.paramsHash : shortId(hashJson(DEFAULT_RULE_PARAMS), 'par');
    const decisions = parent ? [...parent.decisions] : [];
    let derivation = parent ? parent.derivation : null;

    switch (event.kind) {
      case 'projectCreated':
        break;
      case 'materialAdded':
        upsertMaterial(materials, (event as MaterialAdded).material);
        break;
      case 'materialAmended': {
        const ma = event as MaterialAmended;
        upsertMaterial(materials, ma.material, ma.supersedesId);
        break;
      }
      case 'paramsSet': {
        const ps = event as ParamsSet;
        Object.assign(params, ps.params);
        break;
      }
      case 'decision':
        decisions.push(event as Decision);
        break;
      case 'derivationRecorded':
        derivation = (event as DerivationRecorded).derivation;
        break;
    }

    const node: ProjectNode = {
      event,
      depth: parent ? parent.depth + 1 : 0,
      materials,
      params,
      paramsHash: event.kind === 'paramsSet' ? (event as ParamsSet).paramsHash : paramsHash,
      decisions,
      derivation,
      conflicts: detectConflicts(decisions)
    };
    byId.set(event.id, node);
    nodes.push(node);
    if (event.parentId) {
      const list = children.get(event.parentId) ?? [];
      list.push(event.id);
      children.set(event.parentId, list);
    }
  }

  const childSet = new Set<string>();
  for (const ids of children.values()) ids.forEach((id) => childSet.add(id));
  const headIds = nodes.map((n) => n.event.id).filter((id) => !childSet.has(id));
  const created = root as ProjectCreated;
  return { projectId: created.projectId, name: created.name, createdAt: created.timestamp, nodes, byId, children, headIds };
}

export function topoSort(events: Event[]): Event[] {
  const map = new Map(events.map((e) => [e.id, e]));
  const mark = new Map<string, 0 | 1 | 2>();
  const out: Event[] = [];
  const visit = (e: Event): void => {
    const state = mark.get(e.id);
    if (state === 2) return;
    if (state === 1) throw new Error('事件图存在环');
    mark.set(e.id, 1);
    if (e.parentId) {
      const parent = map.get(e.parentId);
      if (parent) visit(parent);
    }
    mark.set(e.id, 2);
    out.push(e);
  };
  const rootsFirst = [...events].sort((a, b) => (a.parentId === null ? -1 : b.parentId === null ? 1 : a.timestamp.localeCompare(b.timestamp)));
  for (const e of rootsFirst) visit(e);
  return out;
}

/**
 * 走到某节点时“现场重算”派生层（不依赖已存储的 derivationRecorded），
 * 用于历史节点回看与导入后重放校验。
 */
export function deriveAtNode(node: ProjectNode, trigger: Derivation['trigger'] = 'initial'): Derivation {
  const { derivation } = derive({
    materials: node.materials,
    params: node.params,
    paramsHash: node.paramsHash,
    decisions: node.decisions.map((d) => ({ targetId: d.targetId, verb: d.verb, payload: d.payload })),
    acceptedDecisionIds: node.decisions.map((d) => d.id),
    trigger,
    parents: [node.event.id]
  });
  return derivation;
}

/** 链上祖先（含自己），供 UI“回到旧事件”恢复当时版本。 */
export function ancestry(state: ProjectState, eventId: string): string[] {
  const chain: string[] = [];
  let cur: string | undefined = eventId;
  while (cur) {
    chain.push(cur);
    cur = state.byId.get(cur)?.event.parentId ?? undefined;
  }
  return chain;
}
