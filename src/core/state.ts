import type {
  BandMaterial,
  CalibrationResult,
  Decision,
  DomainEvent,
  LaneMaterial,
  LadderSpec,
  Material,
  MassResult,
  Project,
  ProjectState,
  CalibrationParams
} from './types';
import { PARAMS_V1 } from './params';

export function emptyState(project: Project): ProjectState {
  return {
    project,
    events: [],
    materials: {},
    calibrationResults: {},
    massResults: {},
    decisions: {},
    params: { baseline: PARAMS_V1 },
    derivations: []
  };
}

/** 只追加事件归约出最新状态；材料快照存于事件内，保证可离线回放。 */
export function applyEvent(state: ProjectState, event: DomainEvent): ProjectState {
  const next: ProjectState = {
    ...state,
    events: [...state.events, event],
    materials: { ...state.materials },
    calibrationResults: { ...state.calibrationResults },
    massResults: { ...state.massResults },
    decisions: { ...state.decisions },
    params: { ...state.params },
    derivations: [...state.derivations],
    project: {
      ...state.project,
      branches: { ...state.project.branches }
    }
  };

  switch (event.type) {
    case 'project-created': {
      const branches = (event.payload.branches as Project['branches']) ?? {};
      next.project = { ...event.payload.project as Project, branches };
      break;
    }
    case 'material-added': {
      const material = event.payload.material as Material;
      next.materials[material.id] = material;
      break;
    }
    case 'auto-detected': {
      for (const m of (event.payload.lanes as LaneMaterial[]) ?? []) next.materials[m.id] = m;
      for (const m of (event.payload.bands as BandMaterial[]) ?? []) next.materials[m.id] = m;
      next.derivations.push({
        kind: 'auto-detection',
        resultIds: ((event.payload.bands as BandMaterial[]) ?? []).map((b) => b.id),
        inputDigest: event.inputDigest,
        paramsVersion: event.payload.paramsVersion as 1 | 2,
        parents: event.parents,
        at: event.at
      });
      break;
    }
    case 'ladder-mapped':
      next.derivations.push({
        kind: 'ladder-mapping',
        resultIds: (event.payload.calibrationIds as string[]) ?? [],
        inputDigest: event.inputDigest,
        paramsVersion: event.payload.paramsVersion as 1 | 2,
        parents: event.parents,
        at: event.at
      });
      break;
    case 'calibration-computed': {
      for (const r of (event.payload.results as CalibrationResult[]) ?? []) next.calibrationResults[r.id] = r;
      next.derivations.push({
        kind: 'calibration',
        resultIds: (event.payload.results as CalibrationResult[]).map((r) => r.id),
        inputDigest: event.inputDigest,
        paramsVersion: event.payload.paramsVersion as 1 | 2,
        parents: event.parents,
        at: event.at
      });
      break;
    }
    case 'mass-computed': {
      for (const r of (event.payload.results as MassResult[]) ?? []) next.massResults[r.id] = r;
      next.derivations.push({
        kind: 'mass',
        resultIds: (event.payload.results as MassResult[]).map((r) => r.id),
        inputDigest: event.inputDigest,
        paramsVersion: event.payload.paramsVersion as 1 | 2,
        parents: event.parents,
        at: event.at
      });
      break;
    }
    case 'decision-made': {
      const decision = event.payload.decision as Decision;
      next.decisions[decision.id] = decision;
      const conflicting = (event.payload.conflictsWith as string[]) ?? [];
      for (const id of conflicting) {
        const prev = next.decisions[id];
        if (prev) next.decisions[id] = { ...prev, verdict: 'conflict', conflictsWith: [...new Set([...prev.conflictsWith, decision.id])] };
      }
      break;
    }
    case 'params-revised': {
      next.params[event.branch] = event.payload.params as CalibrationParams;
      break;
    }
    case 'lane-edited': {
      const lane = event.payload.lane as LaneMaterial;
      next.materials[lane.id] = lane;
      break;
    }
    case 'orientation-corrected': {
      const image = event.payload.image as Material;
      next.materials[image.id] = image;
      break;
    }
  }
  return next;
}

export function replay(events: DomainEvent[], project: Project): ProjectState {
  let state = emptyState(project);
  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  for (const e of ordered) state = applyEvent(state, e);
  return state;
}

/** 回到任意旧事件：只回放该事件及之前（同分支），恢复当时依赖版本与可见结论。 */
export function stateAtSeq(events: DomainEvent[], project: Project, seq: number): ProjectState {
  const visible = events.filter((e) => e.seq <= seq).sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  return replay(visible, project);
}
