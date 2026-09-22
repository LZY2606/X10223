// 事件溯源状态投影：按分支重放事件。事件是唯一事实来源；派生提案与人工修订
// 都作为事件 payload 保存。回到任意旧事件 ⇒ 恢复当时的依赖版本与可见结论。
import { PARAMS_V1, defaultParams } from '../versions.js';
import type {
  Band,
  Branch,
  Calibration,
  Decision,
  FindingPayload,
  Lane,
  Material,
  MolecularWeightEstimate,
  ProjectEvent,
  ProjectState,
} from '../types.js';

export function emptyState(projectId: string, name: string): ProjectState {
  return {
    projectId,
    name,
    branchId: 'main',
    branches: [{ id: 'main', name: 'main' }],
    materials: {},
    lanes: {},
    bands: {},
    mwEstimates: {},
    params: defaultParams(PARAMS_V1),
    events: [],
    diagnostics: [],
    findings: [],
  };
}

// 在某分支上按顺序应用事件（事件必须已按 seq 排序）
export function reduceEvents(
  state: ProjectState,
  branchId: string,
  events: ProjectEvent[],
): ProjectState {
  const s: ProjectState = structuredClone(state);
  s.branchId = branchId;
  s.events = events;
  for (const ev of events) apply(s, ev);
  return s;
}

// 截断到某条事件（含），用于“回到旧事件”
export function stateAtEvent(
  base: ProjectState,
  branchId: string,
  upToEventId: string | undefined,
  allEvents: ProjectEvent[],
): ProjectState {
  const lineage = branchLineage(base, branchId, allEvents);
  const ordered = lineage.events;
  const cut = upToEventId
    ? ordered.findIndex((e) => e.id === upToEventId)
    : ordered.length - 1;
  if (upToEventId && cut < 0) {
    return reduceEvents(emptyState(base.projectId, base.name), branchId, ordered);
  }
  return reduceEvents(emptyState(base.projectId, base.name), branchId, ordered.slice(0, cut + 1));
}

export interface BranchLineage {
  branch: Branch;
  events: ProjectEvent[];
  forks: Branch[];
}

export function branchLineage(
  state: ProjectState,
  branchId: string,
  allEvents: ProjectEvent[],
): BranchLineage {
  const branchesById = new Map(state.branches.map((b) => [b.id, b]));
  const chain: Branch[] = [];
  let cur = branchesById.get(branchId);
  while (cur) {
    chain.unshift(cur);
    cur = cur.forkedFromBranchId ? branchesById.get(cur.forkedFromBranchId) : undefined;
  }
  const visited = new Set(chain.map((b) => b.id));
  const events: ProjectEvent[] = [];
  for (const b of chain) {
    const evs = allEvents
      .filter((e) => e.branchId === b.id)
      .sort((a, z) => a.seq - z.seq);
    if (b.forkPointEventId) {
      const idx = evs.findIndex((e) => e.id === b.forkPointEventId);
      events.push(...evs.slice(0, idx + 1));
    } else {
      events.push(...evs);
    }
  }
  return { branch: chain[chain.length - 1]!, events, forks: chain };
}

function apply(s: ProjectState, ev: ProjectEvent): void {
  const p = ev.payload as Record<string, unknown>;
  switch (ev.kind) {
    case 'project.created':
      s.projectId = String(p.projectId ?? s.projectId);
      s.name = String(p.name ?? s.name);
      break;
    case 'branch.created': {
      const b = p.branch as Branch;
      if (b && !s.branches.some((x) => x.id === b.id)) s.branches.push(b);
      break;
    }
    case 'material.image.registered':
    case 'material.ladder.registered': {
      const m = p.material as Material;
      if (m) s.materials[m.id] = m;
      break;
    }
    case 'acquisition.facts.recorded': {
      const id = String(p.imageMaterialId);
      const img = s.materials[id];
      if (img && img.kind === 'image') {
        s.materials[id] = { ...img, acquisition: p.acquisition as typeof img.acquisition };
      }
      break;
    }
    case 'lanes.auto.proposed': {
      for (const lane of (p.lanes as Lane[]) ?? []) s.lanes[lane.id] = lane;
      break;
    }
    case 'lanes.revised': {
      const lane = p.lane as Lane;
      if (lane) s.lanes[lane.id] = lane;
      break;
    }
    case 'bands.auto.proposed': {
      for (const band of (p.bands as Band[]) ?? []) s.bands[band.id] = band;
      break;
    }
    case 'bands.centers.revised': {
      const band = p.band as Band;
      if (band) s.bands[band.id] = band;
      break;
    }
    case 'ladder.assigned': {
      s.ladderLaneAssignment = {
        laneId: String(p.laneId),
        ladderSpecId: String(p.ladderSpecId),
        eventId: ev.id,
      };
      const lane = s.lanes[String(p.laneId)];
      if (lane) s.lanes[lane.id] = { ...lane, role: 'ladder' };
      break;
    }
    case 'ladder.bands.paired':
      // 配对结果存于随后 calibration.computed；此处仅记录人工强制配对事实
      break;
    case 'calibration.computed': {
      s.calibration = p.calibration as Calibration;
      break;
    }
    case 'mw.computed': {
      for (const mw of (p.estimates as MolecularWeightEstimate[]) ?? []) {
        s.mwEstimates[mw.id] = mw;
      }
      break;
    }
    case 'params.revised': {
      s.params = p.params as ProjectState['params'];
      break;
    }
    case 'decision.recorded': {
      applyDecision(s, p.decision as Decision, ev);
      break;
    }
    case 'finding.recorded':
      break;
    default:
      break;
  }
  if (ev.findings) s.findings.push(...ev.findings);
}

function applyDecision(s: ProjectState, d: Decision, ev: ProjectEvent): void {
  if (!d) return;
  if (d.subjectType === 'lane') {
    const lane = s.lanes[d.subjectId];
    if (lane) s.lanes[d.subjectId] = { ...lane, status: mapped(d.verb) };
  } else if (d.subjectType === 'band') {
    const band = s.bands[d.subjectId];
    if (band) s.bands[d.subjectId] = { ...band, status: bandStatus(d.verb) };
  } else if (d.subjectType === 'mw_estimate') {
    // 接受/否定记录在 findings 中；估计本身不被覆盖
  } else if (d.subjectType === 'calibration_segment') {
    const seg = s.calibration?.segments.find((x) => x.id === d.subjectId);
    if (seg) seg.invalidReasonCode = seg.invalidReasonCode ?? `decision:${d.verb}:${ev.id}`;
  }
}

function mapped(verb: Decision['verb']): Lane['status'] {
  if (verb === 'accept') return 'accepted';
  if (verb === 'reject') return 'rejected';
  return 'proposed';
}

function bandStatus(verb: Decision['verb']): Band['status'] {
  if (verb === 'accept') return 'accepted';
  if (verb === 'reject') return 'rejected';
  if (verb === 'adjust') return 'candidate';
  return 'ambiguous';
}

export function findingsOf(events: ProjectEvent[]): FindingPayload[] {
  return events.flatMap((e) => e.findings ?? []);
}

export function sortedEvents(events: ProjectEvent[]): ProjectEvent[] {
  return [...events].sort((a, b) => a.lineSeq - b.lineSeq);
}
