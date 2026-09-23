import type {
  ArchiveEntry,
  BandCenter,
  Computation,
  ComputationInputRef,
  Diagnostic,
  ImageAsset,
  LadderMark,
  LadderSpec,
  LaneBoundary,
  Material,
  MwResult,
  ParamSet,
  WbEvent,
} from '../shared/types';
import { runComputation } from '../core/pipeline';
import { fitLaneCurve } from '../core/lanes';
import { fitRuler } from '../core/ruler';
import { assessBands } from '../core/bands';
import { inferMwForLane } from '../core/mw';
import type { LaneCurveResult, RulerResult } from '../shared/types';
import type { Store, ProjectRow } from './store';
import { loadCasePack, validateMaterials, type CasePack } from './casepack';
import { runArchive } from './archive';

export interface StateView {
  project: ProjectRow;
  projects: ProjectRow[];
  seq: number;
  maxSeq: number;
  asOf: boolean;
  params: ParamSet;
  units: Record<string, string>;
  basis: Record<string, string>;
  materials: {
    images: ImageAsset[];
    ladders: LadderSpec[];
    lanes: LaneBoundary[];
    marks: LadderMark[];
    bands: BandCenter[];
  };
  computations: Computation[];
  events: WbEvent[];
  decisions: WbEvent[];
  archive: ArchiveEntry[];
  diagnostics: (Diagnostic & { source: string })[];
}

export const MAIN_PROJECT = 'gel-smile-01';

export class GelService {
  private pack: CasePack;

  constructor(
    public readonly store: Store,
    caseDir: string,
  ) {
    this.pack = loadCasePack(caseDir);
  }

  get casePack(): CasePack {
    return this.pack;
  }

  seedIfEmpty(): boolean {
    if (this.store.listProjects().length > 0) return false;
    this.seed();
    return true;
  }

  seed(): void {
    const main = MAIN_PROJECT;
    this.store.addProject(main, this.pack.manifest.title, null, null, 0);
    const importDiagnostics = validateMaterials(this.pack.materials);
    const paramsV1 = this.pack.manifest.params['v1'];
    const e1 = this.store.addEvent(main, 'CASE_IMPORTED', {
      caseId: this.pack.caseId,
      units: this.pack.manifest.units,
      basis: this.pack.manifest.basis,
      params: paramsV1,
      materialCount: this.pack.materials.length,
      diagnostics: importDiagnostics,
      provenance:
        '原图、拍摄方向、曝光、ladder 标称值、lane 边界与条带中心均保留像素级来源（image-pixel 基准）',
    }, this.pack.materials.map((m) => m.id));
    this.store.putMaterials(main, this.pack.materials, e1.seq);

    const e2 = this.store.addEvent(main, 'AUTO_CANDIDATES_COMPUTED', {
      note: '自动候选：条带中心、饱和/拖尾/重叠分级',
    }, [e1.id]);
    const comps = this.runPipeline(main, paramsV1, e2.seq);
    const mwComps = comps.filter((c) => c.kind === 'MW_INFER');
    this.store.addEvent(main, 'MW_INFERRED', {
      computationIds: comps.map((c) => c.id),
      mwResultCount: mwComps.reduce((n, c) => n + ((c.result as { results: MwResult[] }).results?.length ?? 0), 0),
      paramVersion: paramsV1.version,
    }, comps.map((c) => c.id));

    for (const step of this.pack.narrative.steps) {
      this.applyNarrativeStep(main, step.kind, step.payload);
    }
    runArchive(this.store, this.pack, main);
  }

  applyNarrativeStep(projectId: string, kind: string, payload: Record<string, unknown>): void {
    if (kind === 'PARAM_REVISION') {
      this.applyParamRevision(projectId, payload.to as string, payload.reason as string, payload.reviewer as string);
    } else if (kind === 'SOURCE_AMENDMENT') {
      this.applySourceAmendment(projectId, payload.bandId as string, payload.newY as number, payload.reason as string, payload.reviewer as string);
    } else if (kind === 'DECISION_ACCEPT' || kind === 'DECISION_REJECT') {
      this.applyDecision(projectId, {
        action: kind === 'DECISION_ACCEPT' ? 'accept' : 'reject',
        bandId: payload.bandId as string,
        candidateId: payload.candidateId as string | undefined,
        reviewer: payload.reviewer as string,
        note: payload.note as string,
      });
    }
  }

  // 当前参数：由事件流推导（CASE_IMPORTED 的 v1 + 最近的 PARAM_REVISION）
  currentParams(projectId: string, seq?: number): ParamSet {
    const events = this.store.eventsAt(projectId, seq);
    let params = this.pack.manifest.params['v1'];
    for (const e of events) {
      if (e.kind === 'PARAM_REVISION') params = e.payload.params as ParamSet;
    }
    return params;
  }

  // 统一计算管线：lane 曲线 → 局部标尺 → 各泳道分子量推断。
  // 每个计算记录输入摘要、参数版本与父级依赖；等价输入得到相同身份。
  runPipeline(projectId: string, params: ParamSet, seq: number, materialsOverride?: Material[]): Computation[] {
    const materials = materialsOverride ?? this.store.materialsAt(projectId);
    const lanes = materials.filter((m): m is LaneBoundary => m.kind === 'lane').sort((a, b) => a.laneIndex - b.laneIndex);
    const marks = materials.filter((m): m is LadderMark => m.kind === 'ladderMark');
    const bands = materials.filter((m): m is BandCenter => m.kind === 'bandCenter');
    const ladder = materials.find((m): m is LadderSpec => m.kind === 'ladderSpec');
    const computations: Computation[] = [];
    if (!ladder) return computations;

    const refOf = (m: Material): ComputationInputRef => ({ entity: m.kind, id: m.id, revision: m.revision });
    const curveByLane = new Map<string, LaneCurveResult>();
    const curveCompByLane = new Map<string, Computation>();

    for (const lane of lanes) {
      const comp = runComputation({
        kind: 'LANE_CURVE_FIT',
        inputs: [refOf(lane)],
        parents: [],
        params,
        seq,
        run: (budget) => {
          const { result, diagnostics } = fitLaneCurve(lane);
          budget.charge(result.samples.length * 2 + 1);
          return { result, diagnostics };
        },
      });
      computations.push(comp);
      this.store.putComputation(projectId, comp);
      if (comp.status !== 'failed') {
        curveByLane.set(lane.id, comp.result as LaneCurveResult);
        curveCompByLane.set(lane.id, comp);
      }
    }

    const ladderLane = lanes.find((l) => l.role === 'ladder');
    let rulerComp: Computation | null = null;
    let ruler: RulerResult | null = null;
    if (ladderLane && curveByLane.has(ladderLane.id)) {
      const laneMarks = marks.filter((mk) => mk.laneId === ladderLane.id);
      rulerComp = runComputation({
        kind: 'RULER_FIT',
        inputs: [refOf(ladder), refOf(ladderLane), ...laneMarks.map(refOf)],
        parents: [curveCompByLane.get(ladderLane.id)!.id],
        params,
        seq,
        run: (budget) => {
          const outcome = fitRuler(curveByLane.get(ladderLane.id)!, laneMarks, ladder);
          budget.charge(laneMarks.length * 4 + 3);
          if (outcome.failureKind === 'SEMANTIC_UNSOLVABLE') {
            return { result: { unsolvable: true }, diagnostics: outcome.diagnostics };
          }
          return { result: outcome.result, diagnostics: outcome.diagnostics };
        },
      });
      // 语义无解是独立失败类别
      const hasNonMonotonic = rulerComp.diagnostics.some((d) => d.code === 'RULER_NON_MONOTONIC');
      if (hasNonMonotonic) {
        rulerComp = { ...rulerComp, status: 'failed', failureKind: 'SEMANTIC_UNSOLVABLE' };
      } else if (rulerComp.status !== 'failed') {
        ruler = rulerComp.result as RulerResult;
      }
      computations.push(rulerComp);
      this.store.putComputation(projectId, rulerComp);
    }

    const { assessments, diagnostics: bandDiags } = assessBands(bands, params);
    const assessmentByBand = new Map(assessments.map((a) => [a.band.id, a]));

    for (const lane of lanes.filter((l) => l.role === 'sample')) {
      const curve = curveByLane.get(lane.id);
      const curveComp = curveCompByLane.get(lane.id);
      if (!curve || !curveComp || !rulerComp) continue;
      const laneBands = bands.filter((b) => b.laneId === lane.id);
      const comp = runComputation({
        kind: 'MW_INFER',
        inputs: [refOf(lane), ...laneBands.map(refOf)],
        parents: [curveComp.id, rulerComp.id],
        params,
        seq,
        run: (budget) => {
          budget.charge(laneBands.length * 6 + 2);
          if (!ruler) {
            return {
              result: { results: [] },
              diagnostics: [
                {
                  code: 'RULER_UNAVAILABLE',
                  severity: 'error',
                  location: { entity: 'lane', id: lane.id },
                  message: `泳道 ${lane.label} 的分子量推断缺少有效标尺（标尺计算失败）`,
                } satisfies Diagnostic,
              ],
            };
          }
          const outcome = inferMwForLane(lane.id, curve, ruler, laneBands, assessmentByBand, params);
          const relDiags = bandDiags.filter((d) => laneBands.some((b) => b.id === d.location.id));
          return { result: { results: outcome.results }, diagnostics: [...outcome.diagnostics, ...relDiags] };
        },
      });
      computations.push(comp);
      this.store.putComputation(projectId, comp);
    }
    return computations;
  }

  applyParamRevision(projectId: string, toVersion: string, reason: string, reviewer: string): WbEvent {
    const from = this.currentParams(projectId);
    const to = this.pack.manifest.params[toVersion];
    if (!to) throw new Error(`未知参数版本 ${toVersion}`);
    const evt = this.store.addEvent(projectId, 'PARAM_REVISION', {
      from: from.version,
      to: to.version,
      reason,
      reviewer,
      params: to,
    }, []);
    // 旧计算在该事件后失效；as-of 查询仍可回到当时版本
    const old = this.store.computationsAt(projectId);
    this.store.invalidateComputations(projectId, old.map((c) => c.id), evt.seq);
    this.runPipeline(projectId, to, evt.seq);
    return evt;
  }

  applySourceAmendment(projectId: string, bandId: string, newY: number, reason: string, reviewer: string): WbEvent {
    const old = this.store.materialById(projectId, bandId) as BandCenter | null;
    if (!old || old.kind !== 'bandCenter') throw new Error(`条带不存在：${bandId}`);
    const amended: BandCenter = {
      ...old,
      revision: old.revision + 1,
      supersedes: old.id,
      position: { ...old.position, y: newY },
      source: 'manual',
    };
    const evt = this.store.addEvent(projectId, 'SOURCE_AMENDMENT', {
      bandId,
      from: { y: old.position.y, revision: old.revision },
      to: { y: newY, revision: amended.revision },
      reason,
      reviewer,
    }, [bandId]);
    this.store.putMaterials(projectId, [amended], evt.seq);

    // 局部失效：仅输入闭包包含该条带的计算失效，其余保持身份不变
    const affected = this.store
      .computationsAt(projectId)
      .filter((c) => c.inputs.some((i) => i.id === bandId))
      .map((c) => c.id);
    this.store.invalidateComputations(projectId, affected, evt.seq);
    this.runPipeline(projectId, this.currentParams(projectId), evt.seq);
    return evt;
  }

  applyDecision(
    projectId: string,
    decision: { action: 'accept' | 'reject'; bandId: string; candidateId?: string; reviewer: string; note: string },
  ): WbEvent {
    const kind = decision.action === 'accept' ? 'DECISION_ACCEPT' : 'DECISION_REJECT';
    const evt = this.store.addEvent(projectId, kind, { ...decision }, [decision.bandId]);
    if (decision.action === 'accept') {
      const prior = this.store
        .eventsAt(projectId)
        .filter(
          (e) =>
            e.kind === 'DECISION_ACCEPT' &&
            e.seq < evt.seq &&
            (e.payload.bandId as string) === decision.bandId &&
            (e.payload.candidateId as string | undefined) !== decision.candidateId,
        );
      if (prior.length > 0) {
        this.store.addEvent(projectId, 'DECISION_CONFLICT', {
          bandId: decision.bandId,
          candidates: [
            ...prior.map((e) => ({ candidateId: e.payload.candidateId, reviewer: e.payload.reviewer, eventId: e.id })),
            { candidateId: decision.candidateId, reviewer: decision.reviewer, eventId: evt.id },
          ],
          note: '互相冲突的人工决定：全部保留，等待 CONFLICT_RESOLVED',
        }, [evt.id, ...prior.map((e) => e.id)], {
          code: 'HUMAN_DECISION_CONFLICT',
          detail: { bandId: decision.bandId, kept: 'all' },
        });
      }
    }
    return evt;
  }

  getState(projectId: string, seq?: number): StateView {
    const project = this.store.getProject(projectId);
    if (!project) throw new Error(`项目不存在：${projectId}`);
    const maxSeq = this.store.nextSeq(projectId) - 1;
    const bound = seq === undefined ? maxSeq : Math.min(seq, maxSeq);
    const materials = this.store.materialsAt(projectId, bound);
    const computations = this.store.computationsAt(projectId, bound);
    const events = this.store.eventsAt(projectId, bound);
    const diagnostics: (Diagnostic & { source: string })[] = [];
    const importEvt = events.find((e) => e.kind === 'CASE_IMPORTED');
    for (const d of (importEvt?.payload.diagnostics as Diagnostic[] | undefined) ?? []) {
      diagnostics.push({ ...d, source: importEvt!.id });
    }
    for (const c of computations) {
      for (const d of c.diagnostics) diagnostics.push({ ...d, source: c.id });
    }
    return {
      project,
      projects: this.store.listProjects(),
      seq: bound,
      maxSeq,
      asOf: seq !== undefined && bound < maxSeq,
      params: this.currentParams(projectId, bound),
      units: this.pack.manifest.units,
      basis: this.pack.manifest.basis,
      materials: {
        images: materials.filter((m): m is ImageAsset => m.kind === 'image'),
        ladders: materials.filter((m): m is LadderSpec => m.kind === 'ladderSpec'),
        lanes: materials.filter((m): m is LaneBoundary => m.kind === 'lane'),
        marks: materials.filter((m): m is LadderMark => m.kind === 'ladderMark'),
        bands: materials.filter((m): m is BandCenter => m.kind === 'bandCenter'),
      },
      computations,
      events,
      decisions: events.filter((e) => e.kind.startsWith('DECISION') || e.kind === 'CONFLICT_RESOLVED'),
      archive: this.store.archiveAt(projectId),
      diagnostics,
    };
  }
}
