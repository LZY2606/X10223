import type {
  GelEvent,
  Material,
  MaterialType,
  ParameterSet,
  ProjectState,
  Unit,
} from './types.js';
import { canonicalJSON, contentId } from './ids.js';

export const RULE_VERSION = 'gel-rules-1.0.0';

export function eventId(
  projectId: string,
  seq: number,
  branchId: string,
  prevId: string | null,
  payload: unknown,
): string {
  // 不含时间戳：等价输入在任何机器/时间重放都得到同一身份。
  return contentId('evt', projectId, String(seq), branchId, prevId ?? 'ROOT', canonicalJSON(payload));
}

export function parameterSetId(
  global: Record<string, { value: number; unit: Unit }>,
  perLane: Record<string, Record<string, { value: number; unit: Unit }>>,
): string {
  return contentId('params', canonicalJSON({ global, perLane }));
}

/**
 * 追加事件：校验父链与序号。返回新事件（不修改输入）。
 */
export function appendEvent(
  projectId: string,
  branchId: string,
  seq: number,
  prevId: string | null,
  type: GelEvent['type'],
  payload: unknown,
  timestamp: number,
): GelEvent {
  const id = eventId(projectId, seq, branchId, prevId, payload);
  return { id, projectId, seq, branchId, type, prevId, timestamp, payload };
}

/**
 * 收集到达某分支末端需要重放的事件（含分叉基点的父链）。
 * 事件按依赖顺序返回（线性化）。
 */
export function linearize(
  headEventId: string,
  byId: Map<string, GelEvent>,
): GelEvent[] {
  const out: GelEvent[] = [];
  let cursor: string | null = headEventId;
  const seen = new Set<string>();
  while (cursor) {
    if (seen.has(cursor)) throw new Error('event chain cycle at ' + cursor);
    seen.add(cursor);
    const ev = byId.get(cursor);
    if (!ev) throw new Error('missing event ' + cursor);
    out.push(ev);
    if (ev.type === 'branch-created') {
      const from = (ev.payload as { fromEventId: string | null }).fromEventId;
      cursor = from;
    } else {
      cursor = ev.prevId;
    }
  }
  return out.reverse();
}

/**
 * 从事件链投影出某一提交点的项目状态。
 * 材料不可变；“可修改决定”体现为选中版本、参数、决定。
 */
export function project(
  projectId: string,
  branchId: string,
  headEventId: string | null,
  byId: Map<string, GelEvent>,
  materialsById: Map<string, Material>,
): ProjectState {
  const materials: Record<string, Material> = {};
  const selected: Partial<Record<MaterialType, string>> = {};
  const selectedBands: Record<string, string> = {};
  const events = headEventId ? linearize(headEventId, byId) : [];

  const global: Record<string, { value: number; unit: Unit }> = {
    ...defaultGlobalParams(),
  };
  const perLane: Record<string, Record<string, { value: number; unit: Unit }>> = {};

  for (const ev of events) {
    switch (ev.type) {
      case 'material-added': {
        const p = ev.payload as { materialId: string };
        const m = materialsById.get(p.materialId);
        if (!m) throw new Error('dangling material ' + p.materialId);
        materials[m.id] = m;
        if (m.type === 'band-centers') selectedBands[m.laneId] = m.id;
        else selected[m.type] = m.id;
        break;
      }
      case 'parameter-revised': {
        const p = ev.payload as {
          scope: 'global' | { laneId: string };
          key: string;
          value: number;
          unit: Unit;
        };
        if (p.scope === 'global') global[p.key] = { value: p.value, unit: p.unit };
        else {
          perLane[p.scope.laneId] ??= {};
          perLane[p.scope.laneId]![p.key] = { value: p.value, unit: p.unit };
        }
        break;
      }
      default:
        break;
    }
  }

  const parameters: ParameterSet = {
    id: parameterSetId(global, perLane),
    global,
    perLane,
  };

  return {
    projectId,
    branchId,
    headEventId,
    materials,
    selected,
    selectedBands,
    events,
    parameters,
  };
}

export function defaultGlobalParams(): Record<string, { value: number; unit: Unit }> {
  // 这些是算法参数（有版本），不是领域缺失值的替身。
  return {
    minProminence: { value: 18, unit: 'graylevel' },
    profileHalfWidth: { value: 10, unit: 'pixel' },
    overlapDistance: { value: 14, unit: 'pixel' },
    tailingAsymmetry: { value: 1.6, unit: 'ratio' },
  };
}

export function param(
  state: ProjectState,
  laneId: string,
  key: string,
): { value: number; unit: Unit } {
  const local = state.parameters.perLane[laneId]?.[key];
  if (local) return local;
  const g = state.parameters.global[key];
  if (!g) throw new Error(`missing parameter ${key}`);
  return g;
}
