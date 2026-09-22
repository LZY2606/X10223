/**
 * 重计算：对当前可见的条带逐个做分子量推断。
 * 计算记录携带输入摘要（对象 hash）、参数版本与父级依赖；
 * 输入未变的条带得到相同计算 id，自动跳过——实现局部失效的精确边界。
 */
import { canonical, contentId, sha256 } from '../shared/ids.js';
import {
  buildLadderScale,
  estimateBandMW,
  overlapPeerPositions,
  sortBandsDeterministically,
  type MwParams
} from '../shared/infer.js';
import type { BandObject, ComputationRecord, LaneObject, LadderObject } from '../shared/types.js';
import type { GelStore } from './db.js';

export interface RecomputeResult {
  inserted: ComputationRecord[];
  skippedUnchanged: string[];
  superseded: string[];
}

export function recomputeMW(store: GelStore, params: MwParams, onlyBandIds?: Set<string>): RecomputeResult {
  const lanes = store.objects('lane', { currentOnly: true }).map((o) => o.data as LaneObject);
  const lanesById = new Map(lanes.map((l) => [l.id, l]));
  const ladderStored = store.objects('ladder', { currentOnly: true })[0];
  if (!ladderStored) throw new Error('缺少 ladder 材料，无法重计算');
  const ladder = ladderStored.data as LadderObject;
  const ladderLane = lanesById.get(ladder.laneId);
  if (!ladderLane) throw new Error(`ladder 引用的泳道 ${ladder.laneId} 不存在`);
  const scale = buildLadderScale(ladder, ladderLane);

  const bands = store
    .objects('band', { currentOnly: true })
    .map((o) => o.data as BandObject)
    .filter((b) => !onlyBandIds || onlyBandIds.has(b.id));
  const ordered = sortBandsDeterministically(bands, lanesById);

  const allBands = store.objects('band', { currentOnly: true }).map((o) => o.data as BandObject);
  const visible = store.visibleComputationsAt(store.currentSeq());
  const visibleByBand = new Map<string, ComputationRecord[]>();
  for (const c of visible) {
    const list = visibleByBand.get(c.bandId) ?? [];
    list.push(c);
    visibleByBand.set(c.bandId, list);
  }

  const inserted: ComputationRecord[] = [];
  const skippedUnchanged: string[] = [];
  const superseded: string[] = [];

  for (const band of ordered) {
    const lane = lanesById.get(band.laneId);
    let ctx: { overlapPeerS?: number[] } = {};
    if (band.overlapGroupId && lane) {
      const group = allBands.filter((b) => b.overlapGroupId === band.overlapGroupId);
      ctx = { overlapPeerS: overlapPeerPositions(group, lane) };
    }
    const { estimate, diagnostics } = estimateBandMW(band, lane, scale, lanesById, params, ctx);
    const inputHash = sha256(
      canonical({
        band: band.hash,
        lane: lane?.hash ?? null,
        ladder: ladder.hash,
        ladderLane: ladderLane.hash,
        params
      })
    );
    const id = contentId('cmp', { bandId: band.id, paramVersion: params.version, inputHash });
    const existing = (visibleByBand.get(band.id) ?? []).filter((c) => c.paramVersion === params.version);
    if (existing.some((c) => c.id === id)) {
      skippedUnchanged.push(band.id);
      continue;
    }
    for (const old of existing) {
      store.supersedeComputation(old.id);
      superseded.push(old.id);
    }
    const rec = store.insertComputation({
      id,
      kind: 'mw-estimate',
      bandId: band.id,
      paramVersion: params.version,
      inputHash,
      parents: [band.id, band.laneId, ladder.id, ladderLane.id],
      result: estimate,
      diagnostics
    });
    inserted.push(rec);
  }
  return { inserted, skippedUnchanged, superseded };
}
