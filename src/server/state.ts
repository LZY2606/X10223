import type { DatabaseSync } from 'node:sqlite';
import type { BandResult, Diagnostic, Event, GelParams, Material } from '../shared/types.js';
import { PARAMS_V1 } from '../shared/types.js';
import { loadMaterialsForBranch, recordResults } from './db.js';
import { computeBranch } from './domain.js';

export interface ReplayState {
  branch: string;
  atSeq: number;
  headSeq: number;
  event: Event;
  materials: Material[];
  params: GelParams;
  results: BandResult[];
  diagnostics: Diagnostic[];
  ladder?: ReturnType<typeof computeBranch>['ladder'];
  inputDigest: string;
}

// 重放至指定事件（时间旅行）：只折叠 <= atSeq 且在该分支祖先链上的决定
export function replayAt(
  db: DatabaseSync,
  branch: string,
  atSeq?: number,
  opts: { persist?: boolean } = {}
): ReplayState | null {
  const all = db
    .prepare('SELECT * FROM events WHERE branch = ? ORDER BY seq', {})
    .all(branch) as Record<string, unknown>[];
  const branchEvents = all.map((r) => {
    const parents = JSON.parse(r.parents as string) as string[];
    return {
      id: r.id as string,
      seq: r.seq as number,
      branch: r.branch as string,
      type: r.type as Event['type'],
      parents,
      paramsVersion: r.params_version as string,
      inputDigest: r.input_digest as string,
      createdAt: r.created_at as string,
      payload: JSON.parse(r.payload as string) as Record<string, unknown>
    } satisfies Event;
  });
  if (branchEvents.length === 0) return null;
  const headSeq = Math.max(...branchEvents.map((e) => e.seq));
  const targetSeq = Math.min(atSeq ?? headSeq, headSeq);

  const decisions: Event[] = [];
  let params: GelParams = { ...PARAMS_V1 };
  let event: Event = branchEvents[0];
  for (const e of branchEvents) {
    if (e.seq > targetSeq) break;
    event = e;
    if (e.type === 'params-revised' && e.payload.params) params = e.payload.params as GelParams;
    if (e.type === 'human-decision' || e.type === 'conflict-resolved') decisions.push(e);
  }

  const materials = loadMaterialsForBranch(db, branch, targetSeq);
  const computed = computeBranch({
    branch,
    materials,
    params,
    decisions,
    eventId: event.id
  });

  if (opts.persist) recordResults(db, event, computed.results);

  return {
    branch,
    atSeq: targetSeq,
    headSeq,
    event,
    materials,
    params,
    results: computed.results,
    diagnostics: computed.diagnostics,
    ladder: computed.ladder,
    inputDigest: computed.inputDigest
  };
}
