// Event-sourced project engine: commands append events; state is replayed.
// Every derived result carries input digest, params hash and parent deps.
import {
  CalibrationParams, Decision, GelEvent, InferenceVerdict, Material, ProjectState,
  DomainError,
} from './types.js';
import { canonicalJSON, materialId, paramsHash, sha256Hex, valueId } from './ids.js';
import { computeAll } from './compute.js';

export const DEFAULT_PARAMS: CalibrationParams = {
  version: 'calib/1.0.0', model: 'log-linear-piecewise',
  saturationThreshold: 0.95, minLadderPoints: 3, maxBridgedGap: 2, evalBudget: 10000,
};

export type Command =
  | { kind: 'register'; material: DistributiveOmit<Material, 'id'> }
  | { kind: 'supersede'; oldMaterialId: string; newMaterial: DistributiveOmit<Material, 'id'>; reason: string }
  | { kind: 'activateParams'; params: Omit<CalibrationParams, 'hash'> }
  | { kind: 'compute' }
  | { kind: 'decide'; targetValueId: string; action: 'accept' | 'reject' | 'adjust';
      adjusted?: InferenceVerdict; note: string; actor: string }
  | { kind: 'fork'; newBranch: string; fromEvent?: string };

type DistributiveOmit<T, K extends keyof any> = T extends any ? Omit<T, K> : never;

export function idForMaterial(m: DistributiveOmit<Material, 'id'>): string {
  switch (m.kind) {
    case 'image':
      return materialId('image', { pngBase64: m.pngBase64, orientation: m.orientation, exposure: m.exposure });
    case 'ladder':
      return materialId('ladder', { laneId: m.laneId, nominals: m.nominals, missingIndexes: m.missingIndexes });
    case 'lane':
      return materialId('lane', { laneId: m.laneId, centerlinePx: m.centerlinePx, halfWidthPx: m.halfWidthPx });
    case 'band':
      return materialId('band', { laneId: m.laneId, bandKey: m.bandKey, centerPx: m.centerPx, role: m.role });
  }
}

export function withParamsHash(p: Omit<CalibrationParams, 'hash'>): CalibrationParams {
  const { version, ...rest } = p;
  return { ...p, hash: paramsHash(version, rest) };
}

export interface PreparedEvent {
  event: GelEvent;
  error?: DomainError;
}

/**
 * Reduce a branch's ordered events into a state. Events are content-addressed
 * and replayable; checking out any old event reconstructs THAT point's params
 * version and visible conclusions (never overwritten by newer computations).
 */
export function reduceEvents(projectId: string, events: GelEvent[]): ProjectState {
  const ordered = [...events].sort((a, b) => a.seq - b.seq || a.id.localeCompare(b.id));
  const materials: Material[] = [];
  let params: CalibrationParams = DEFAULT_PARAMS;
  let inferences: ProjectState['inferences'] = [];
  let decisions: Decision[] = [];
  let diagnostics: ProjectState['diagnostics'] = [];
  let calibration: ProjectState['calibration'] = {};
  let headEvent: string | null = null;

  for (const ev of ordered) {
    headEvent = ev.id;
    if (ev.type === 'material.registered') {
      const mat = ev.payload.material as Material;
      if (!materials.some((m) => m.id === mat.id)) materials.push(mat);
    } else if (ev.type === 'material.superseded') {
      const oldId = ev.payload.oldMaterialId as string;
      const mat = ev.payload.material as Material;
      if (!materials.some((m) => m.id === mat.id)) materials.push(mat);
      const idx = materials.findIndex((m) => m.id === oldId);
      if (idx >= 0) materials.splice(idx, 1);
    } else if (ev.type === 'params.activated') {
      params = ev.payload.params as CalibrationParams;
    } else if (ev.type === 'inference.computed') {
      inferences = ev.payload.inferences as typeof inferences;
      calibration = ev.payload.calibration as typeof calibration;
      diagnostics = ev.payload.diagnostics as typeof diagnostics;
    } else if (ev.type.startsWith('decision.')) {
      decisions = ev.payload.decisions as Decision[];
    } else if (ev.type === 'diagnostic.raised') {
      diagnostics = [...diagnostics, ev.payload.diagnostic as typeof diagnostics[number]];
    }
  }
  return { projectId, materials, params, inferences, decisions, diagnostics, calibration, headEvent };
}

/**
 * Decide whether a new command can be applied and which parent events it reads.
 * Returns the event to append (or the domain error that must be recorded).
 */
export function prepareCommand(
  projectId: string,
  branch: string,
  seq: number,
  state: ProjectState,
  cmd: Command,
): PreparedEvent {
  const base = (type: GelEvent['type'], payload: Record<string, unknown>, parents: string[]): GelEvent => {
    const content = { project: projectId, branch, seq, type, parents, payload };
    return { id: `evt_${sha256Hex(canonicalJSON(content)).slice(0, 16)}`, branch, seq, type, parents, payload, hash: sha256Hex(canonicalJSON({ ...content })) };
  };
  const parents = state.headEvent ? [state.headEvent] : [];

  switch (cmd.kind) {
    case 'register': {
      const mat = { ...cmd.material, id: idForMaterial(cmd.material) } as Material;
      return { event: base('material.registered', { material: mat }, parents) };
    }
    case 'supersede': {
      if (!state.materials.some((m) => m.id === cmd.oldMaterialId)) {
        return {
          event: base('diagnostic.raised', {
            diagnostic: { code: 'INPUT_INCOMPLETE' as const, location: `material[${cmd.oldMaterialId}]`,
              message: 'cannot supersede a material that is not present' },
          }, parents),
          error: new DomainError('INPUT_INCOMPLETE', {
            code: 'INPUT_INCOMPLETE', location: `material[${cmd.oldMaterialId}]`,
            message: 'cannot supersede a material that is not present' }),
        };
      }
      const mat = { ...cmd.newMaterial, id: idForMaterial(cmd.newMaterial) } as Material;
      return { event: base('material.superseded',
        { oldMaterialId: cmd.oldMaterialId, material: mat, reason: cmd.reason },
        [...parents, cmd.oldMaterialId]) };
    }
    case 'activateParams': {
      const params = withParamsHash(cmd.params);
      return { event: base('params.activated', { params }, parents) };
    }
    case 'compute': {
      let result;
      try {
        result = computeAll(state.materials, state.params);
      } catch (e) {
        if (e instanceof DomainError) {
          return {
            event: base('diagnostic.raised', { diagnostic: e.diagnostic, branch }, parents),
            error: e,
          };
        }
        throw e;
      }
      return {
        event: base('inference.computed', {
          inferences: result.inferences, calibration: result.calibration,
          diagnostics: result.diagnostics, inputDigest: result.inputDigest,
          paramsHash: state.params.hash,
        }, parents),
      };
    }
    case 'decide': {
      const target = state.inferences.find((i) => i.id === cmd.targetValueId);
      if (!target) {
        return {
          event: base('diagnostic.raised', {
            diagnostic: { code: 'INPUT_INCOMPLETE' as const, location: `decision[${cmd.targetValueId}]`,
              message: 'no inference with that stable value id at this point in history' },
          }, parents),
          error: new DomainError('INPUT_INCOMPLETE', {
            code: 'INPUT_INCOMPLETE', location: `decision[${cmd.targetValueId}]`,
            message: 'no inference with that stable value id at this point in history' }),
        };
      }
      const decisions = [...state.decisions];
      const existing = decisions.find((d) => d.targetValueId === cmd.targetValueId);
      const next: Decision = {
        eventId: '', targetValueId: cmd.targetValueId, action: cmd.action,
        adjusted: cmd.adjusted, note: cmd.note, actor: cmd.actor,
      };
      let type: GelEvent['type'] =
        cmd.action === 'accept' ? 'decision.accept' :
        cmd.action === 'reject' ? 'decision.reject' : 'decision.adjust';
      if (existing && conflicts(existing.action, cmd.action)) {
        type = 'decision.conflict';
      }
      if (existing) {
        const idx = decisions.indexOf(existing);
        decisions[idx] = { ...next, eventId: '__pending__' };
      } else {
        decisions.push(next);
      }
      const ev = base(type, { decisions: decisions.map((d) => ({ ...d, eventId: '' })) },
        [...parents, cmd.targetValueId]);
      ev.payload.decisions = (ev.payload.decisions as Decision[]).map((d) => ({ ...d, eventId: ev.id }));
      return { event: ev };
    }
    case 'fork': {
      return { event: base('branch.created', { newBranch: cmd.newBranch, fromEvent: cmd.fromEvent ?? state.headEvent }, parents) };
    }
  }
}

function conflicts(a: Decision['action'], b: Decision['action']): boolean {
  if (a === b) return false;
  if ((a === 'accept' && b === 'reject') || (a === 'reject' && b === 'accept')) return true;
  return true; // any change after a prior verdict is recorded as conflict-bearing
}

export function eventDigest(ev: GelEvent): string {
  return sha256Hex(canonicalJSON({ ...ev, hash: undefined }));
}
