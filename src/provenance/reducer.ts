import type { GelInput, ImageMaterial, LadderMaterial } from '../core/types';
import type { AnalysisResult } from '../core/analyze';
import type {
  BranchState,
  DecisionDetail,
  ProvenanceEvent,
} from './events';

export const DEFAULT_PARAM_VERSION = 'params.v1';

export interface ProjectState {
  projectId: string;
  name: string;
  createdAt: string;
  /** L0 不可变材料（含被修订的旧版本，按 materialId 保留全部）。 */
  materials: Record<string, ImageMaterial | LadderMaterial>;
  /** 当前每个角色引用的材料 id。 */
  materialBindings: { imageMaterialId: string; ladderMaterialId: string };
  events: ProvenanceEvent[];
  branches: Map<string, BranchState>;
  branchOrder: string[];
  headBranchId: string;
}

export function emptyProject(projectId: string, name: string, createdAt: string): ProjectState {
  const main: BranchState = {
    branchId: 'main',
    parentBranchId: null,
    forkedFromEventId: null,
    lanes: [],
    bands: [],
    latestAnalysis: null,
    adopted: {},
    decisions: [],
    diagnostics: [],
    conflicts: [],
    paramVersion: DEFAULT_PARAM_VERSION,
  };
  return {
    projectId,
    name,
    createdAt,
    materials: {},
    materialBindings: { imageMaterialId: '', ladderMaterialId: '' },
    events: [],
    branches: new Map([['main', main]]),
    branchOrder: ['main'],
    headBranchId: 'main',
  };
}

export function cloneBranch(b: BranchState): BranchState {
  return {
    ...b,
    lanes: b.lanes.map((x) => ({ ...x })),
    bands: b.bands.map((x) => ({ ...x, overlapsWith: [...x.overlapsWith] })),
    adopted: { ...b.adopted },
    decisions: b.decisions.map((x) => ({ ...x })),
    conflicts: b.conflicts.map((x) => ({ ...x, decisions: [...x.decisions] })),
    diagnostics: b.diagnostics.map((x) => ({ ...x, location: x.location ? { ...x.location } : undefined })),
    latestAnalysis: b.latestAnalysis ? { ...b.latestAnalysis } : null,
  };
}

export function gelInputOf(state: ProjectState, branch: BranchState): GelInput {
  const image = state.materials[state.materialBindings.imageMaterialId] as ImageMaterial;
  const ladder = state.materials[state.materialBindings.ladderMaterialId] as LadderMaterial;
  return { image, ladder, lanes: branch.lanes, bands: branch.bands };
}

/** 重放全部事件（或直到某事件，含），重建状态。回到旧事件即用旧参数版本。 */
export function replay(
  initial: ProjectState,
  untilEventId?: string,
): ProjectState {
  const state = emptyProject(initial.projectId, initial.name, initial.createdAt);
  state.materials = { ...initial.materials };
  for (const event of initial.events) {
    applyEvent(state, event);
    state.events.push(event);
    if (untilEventId && event.eventId === untilEventId) break;
  }
  state.headBranchId = lastActiveBranch(state);
  return state;
}

function lastActiveBranch(state: ProjectState): string {
  return state.events.length ? state.events[state.events.length - 1]!.branchId : 'main';
}

export function applyEvent(state: ProjectState, event: ProvenanceEvent): void {
  const ensureBranch = (branchId: string): BranchState => {
    let b = state.branches.get(branchId);
    if (!b) {
      b = {
        branchId,
        parentBranchId: null,
        forkedFromEventId: null,
        lanes: [],
        bands: [],
        latestAnalysis: null,
        adopted: {},
        decisions: [],
        diagnostics: [],
        conflicts: [],
        paramVersion: DEFAULT_PARAM_VERSION,
      };
      state.branches.set(branchId, b);
      state.branchOrder.push(branchId);
    }
    return b;
  };

  switch (event.type) {
    case 'project-created':
      state.name = (event.payload.name as string) ?? state.name;
      break;
    case 'branch-created': {
      const { newBranchId, fromBranchId } = event.payload as { newBranchId: string; fromBranchId: string };
      const src = state.branches.get(fromBranchId) ?? state.branches.get('main')!;
      const nb = cloneBranch(src);
      nb.branchId = newBranchId;
      nb.parentBranchId = fromBranchId;
      nb.forkedFromEventId = (event.payload.forkedFromEventId as string) ?? null;
      state.branches.set(newBranchId, nb);
      state.branchOrder.push(newBranchId);
      state.headBranchId = newBranchId;
      break;
    }
    case 'materials-imported': {
      const p = event.payload as {
        image?: ImageMaterial | ReturnType<typeof import('../server/projectService').serializeImage>;
        ladder?: LadderMaterial;
        imageMaterialId?: string;
        ladderMaterialId?: string;
      };
      if (p.image) {
        const img =
          'grayscaleBase64' in (p.image as object)
            ? deserializeImageMaterial(p.image as any)
            : (p.image as ImageMaterial);
        state.materials[img.materialId] = img;
        state.materialBindings.imageMaterialId = img.materialId;
      }
      if (p.ladder) {
        state.materials[p.ladder.materialId] = p.ladder;
        state.materialBindings.ladderMaterialId = p.ladder.materialId;
      }
      if (p.imageMaterialId) state.materialBindings.imageMaterialId = p.imageMaterialId;
      if (p.ladderMaterialId) state.materialBindings.ladderMaterialId = p.ladderMaterialId;
      break;
    }
    case 'lanes-annotated': {
      const b = ensureBranch(event.branchId);
      const lanes = event.payload.lanes as GelInput['lanes'];
      // 修订不覆盖：supersedes 链保留旧标注。
      b.lanes = mergeLanes(b.lanes, lanes);
      break;
    }
    case 'bands-annotated': {
      const b = ensureBranch(event.branchId);
      const bands = event.payload.bands as GelInput['bands'];
      b.bands = mergeBands(b.bands, bands);
      break;
    }
    case 'auto-analysis':
    case 'parameter-revised': {
      const b = ensureBranch(event.branchId);
      if (event.type === 'parameter-revised') {
        b.paramVersion = (event.payload.paramVersion as string) ?? b.paramVersion;
      }
      const snap = event.payload.snapshot as BranchState['latestAnalysis'];
      if (snap) b.latestAnalysis = snap;
      if (event.payload.lanes) b.lanes = mergeLanes(b.lanes, event.payload.lanes as GelInput['lanes']);
      if (event.payload.bands) b.bands = mergeBands(b.bands, event.payload.bands as GelInput['bands']);
      break;
    }
    case 'decision': {
      const b = ensureBranch(event.branchId);
      const detail = event.payload.decision as DecisionDetail;
      b.decisions.push(detail);
      if (detail.action === 'accept' && detail.acceptedCandidateId) {
        b.adopted[detail.targetId] = detail.acceptedCandidateId;
      }
      if (detail.action === 'reject') {
        for (const id of detail.rejectedCandidateIds ?? []) {
          if (b.adopted[detail.targetId] === id) b.adopted[detail.targetId] = undefined;
        }
      }
      if (detail.action === 'adjust' && detail.acceptedCandidateId) {
        b.adopted[detail.targetId] = detail.acceptedCandidateId;
      }
      recomputeConflicts(b);
      break;
    }
    case 'source-mutated': {
      const b = ensureBranch(event.branchId);
      // 直接材料已在 materials-imported 中换绑；此处记录受影响对象诊断。
      if (Array.isArray(event.payload.diagnostics)) {
        b.diagnostics = event.payload.diagnostics as BranchState['diagnostics'];
      }
      break;
    }
    case 'evidence-judgment':
      ensureBranch(event.branchId);
      break;
    case 'note':
      break;
  }
}

function mergeLanes(existing: GelInput['lanes'], incoming: GelInput['lanes']): GelInput['lanes'] {
  const byId = new Map(existing.map((l) => [l.laneId, l]));
  for (const lane of incoming) byId.set(lane.laneId, lane);
  return [...byId.values()];
}

function mergeBands(existing: GelInput['bands'], incoming: GelInput['bands']): GelInput['bands'] {
  const byId = new Map(existing.map((x) => [x.bandId, x]));
  for (const band of incoming) byId.set(band.bandId, band);
  return [...byId.values()];
}

/** 互相冲突的人工决定：同一 targetId 上 accept 了不同候选，且未 reject 前者。 */
function recomputeConflicts(b: BranchState): void {
  const byTarget = new Map<string, DecisionDetail[]>();
  for (const d of b.decisions) {
    if (d.action !== 'accept' && d.action !== 'adjust') continue;
    const arr = byTarget.get(d.targetId) ?? [];
    arr.push(d);
    byTarget.set(d.targetId, arr);
  }
  b.conflicts = [];
  for (const [targetId, decisions] of byTarget) {
    const chosen = new Set(decisions.map((d) => d.acceptedCandidateId).filter(Boolean));
    if (chosen.size > 1) {
      b.conflicts.push({ targetId, decisions: decisions.map((d) => d.decisionId) });
    }
  }
}


function deserializeImageMaterial(json: any): ImageMaterial {
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
