import { ancestorClosure, EventLog } from "./events.js";
import type {
  BandCenter,
  BandMwDecision,
  Decision,
  Event,
  ImageMaterial,
  LaneBoundary,
  LadderNominal,
  ExposureMaterial,
  Material,
  OrientationMaterial,
  ParamsMaterial,
  ProjectMeta,
} from "./types.js";

export interface EffectiveState {
  project: ProjectMeta;
  events: Event[];
  headEventId: string;
  image?: ImageMaterial;
  orientation?: OrientationMaterial;
  exposure?: ExposureMaterial;
  /** 全部历史材料（含被取代的），按提交顺序 */
  materialHistory: Material[];
  laneBoundaries: LaneBoundary[];
  bandCenters: BandCenter[];
  ladderNominals: LadderNominal[];
  /** 每种参数的当前版本 */
  params: Partial<Record<ParamsMaterial["paramSet"], ParamsMaterial>>;
  paramHistory: ParamsMaterial[];
  /** 主体 id → 最新决定 */
  decisions: Record<string, Decision>;
  decisionHistory: Decision[];
  /** 分支名 → 头事件 id */
  branchHeads: Record<string, string>;
}

/** 从一个有序事件列表（祖先闭包）归约出有效状态 */
export function reduceState(
  project: ProjectMeta,
  events: Event[],
  headEventId: string,
): EffectiveState {
  const ordered = [...events].sort((a, b) => a.at - b.at || a.seq - b.seq);
  const materialHistory: Material[] = [];
  const laneBoundaries: LaneBoundary[] = [];
  const bandCenters: BandCenter[] = [];
  const ladderNominals: LadderNominal[] = [];
  const params: EffectiveState["params"] = {};
  const paramHistory: ParamsMaterial[] = [];
  const decisions: Record<string, Decision> = {};
  const decisionHistory: Decision[] = [];
  const branchHeads: Record<string, string> = {};
  let image: ImageMaterial | undefined;
  let orientation: OrientationMaterial | undefined;
  let exposure: ExposureMaterial | undefined;
  const superseded = new Set<string>();

  for (const e of ordered) {
    branchHeads[e.branch] = e.id;
    const p = e.payload;
    if (p.type === "materialAdded" || p.type === "materialSuperseded") {
      if (p.type === "materialSuperseded") superseded.add(p.oldMaterialId);
      const m = p.material;
      materialHistory.push(m);
      switch (m.kind) {
        case "image":
          image = m;
          break;
        case "orientation":
          orientation = m;
          break;
        case "exposure":
          exposure = m;
          break;
        case "laneBoundary":
          laneBoundaries.push(m);
          break;
        case "bandCenter":
          bandCenters.push(m);
          break;
        case "ladderNominal":
          ladderNominals.push(m);
          break;
      }
    } else if (p.type === "paramsRevision") {
      params[p.params.paramSet] = p.params;
      paramHistory.push(p.params);
    } else if (p.type === "decision") {
      decisions[p.decision.subjectId] = p.decision;
      decisionHistory.push(p.decision);
    }
  }

  const liveLanes = laneBoundaries.filter((l) => !superseded.has(l.id));
  const liveBands = bandCenters.filter((b) => !superseded.has(b.id));
  const liveNominals = ladderNominals.filter((n) => !superseded.has(n.id));

  return {
    project,
    events: ordered,
    headEventId,
    image,
    orientation,
    exposure,
    materialHistory,
    laneBoundaries: liveLanes,
    bandCenters: liveBands,
    ladderNominals: liveNominals,
    params,
    paramHistory,
    decisions,
    decisionHistory,
    branchHeads,
  };
}

/** 以任意历史事件为视角，恢复当时的依赖版本与可见结论（不用最新结果覆盖历史） */
export function stateAsOf(log: EventLog, project: ProjectMeta, eventId: string): EffectiveState {
  const closure = ancestorClosure(log, eventId);
  return reduceState(project, closure, eventId);
}

export function headState(log: EventLog, project: ProjectMeta, branch: string): EffectiveState {
  const evts = log.branchEvents(branch);
  if (evts.length === 0) throw new Error(`分支 ${branch} 不存在`);
  return stateAsOf(log, project, evts[evts.length - 1]!.id);
}

/** 判断某主体的最新决定是否为接受（用于过滤展示，不改变派生） */
export function isAccepted(decisions: Record<string, Decision>, subjectId: string): boolean {
  const d = decisions[subjectId] as BandMwDecision | undefined;
  return d?.verdict === "accepted";
}
