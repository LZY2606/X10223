/** 视图组装：把存储层记录组装成审阅页所需的投影。 */
import { buildLadderScale, validRegionForLane, MW_PARAMS_V2 } from '../shared/infer.js';
import type { BandObject, ComputationRecord, LaneObject, LadderObject } from '../shared/types.js';
import type { GelStore } from './db.js';

export interface ComputationView extends ComputationRecord {
  decision: { action: string; branch: string; eventSeq: number } | null;
}

export function buildView(store: GelStore, seq: number): ComputationView[] {
  const decisions = store.decisionStatusAt(seq);
  return store.visibleComputationsAt(seq).map((c) => ({ ...c, decision: decisions.get(c.id) ?? null }));
}

export function bandTrace(store: GelStore, bandId: string, seq?: number) {
  const at = seq ?? store.currentSeq();
  const comps = store
    .visibleComputationsAt(at)
    .filter((c) => c.bandId === bandId)
    .sort((a, b) => b.createdSeq - a.createdSeq);
  const comp = comps[0];
  const band = store.objectById<BandObject>(bandId);
  if (!band) return { error: `条带 ${bandId} 不存在` };
  if (!comp) return { error: `条带 ${bandId} 在该时刻没有可见计算`, band };

  const ladderId = comp.parents.find((p) => store.objectById(p)?.kind === 'ladder');
  const ladderLaneId = comp.parents[3];
  const ladder = ladderId ? store.objectById<LadderObject>(ladderId) : undefined;
  const ladderLane = ladderLaneId ? store.objectById<LaneObject>(ladderLaneId) : undefined;
  const lane = store.objectById<LaneObject>(band.laneId);

  let segment = null;
  let ladderEndpoints: unknown[] = [];
  let residuals: unknown[] = [];
  if (ladder && ladderLane) {
    const scale = buildLadderScale(ladder, ladderLane);
    const segId =
      comp.result.kind === 'value' || comp.result.kind === 'interval' ? comp.result.segmentId : null;
    segment = scale.segments.find((s) => s.id === segId) ?? null;
    if (segment) {
      ladderEndpoints = ladder.points.filter((p) => segment!.pointIds.includes(p.id));
    }
    residuals = scale.residuals.map((r) => {
      const pt = ladder.points.find((p) => p.id === r.pointId);
      return { ...r, mwBp: pt?.mwBp ?? null, center: pt?.center ?? null };
    });
  }
  const parentObjects = comp.parents
    .map((p) => store.objectById(p))
    .filter(Boolean)
    .map((o) => ({ id: o!.id, kind: o!.kind, hash: o!.hash }));

  return {
    computation: comp,
    band,
    lane,
    segment,
    ladderEndpoints,
    validRegion:
      comp.result.kind === 'value' || comp.result.kind === 'interval'
        ? comp.result.validRegion
        : lane && segment
          ? validRegionForLane(segment, lane)
          : null,
    residuals,
    parents: parentObjects,
    paramVersion: comp.paramVersion
  };
}

export function projectState(store: GelStore) {
  const seq = store.currentSeq();
  const image = store.objects('gel-image', { currentOnly: true })[0]?.data ?? null;
  const lanes = store.objects('lane', { currentOnly: true }).map((o) => o.data);
  const ladder = store.objects('ladder', { currentOnly: true })[0]?.data ?? null;
  const bands = store.objects('band', { currentOnly: true }).map((o) => o.data);
  const computations = buildView(store, seq);
  const diagnostics = computations.flatMap((c) => c.diagnostics);
  const events = store.events();
  return {
    seq,
    image,
    lanes,
    ladder,
    bands,
    computations,
    diagnostics,
    events,
    paramVersion: MW_PARAMS_V2.version,
    units: { mw: 'bp', length: 'px', exposure: 'ms' }
  };
}
