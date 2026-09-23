import type { BranchInfo, GelEvent, EventType } from './types';
import { stableId } from './hash';

/**
 * Append-only 事件链工具：
 *  - 事件 id = hash(project, branch, seq, parent, type, payload)；
 *  - parentEventId 形成哈希链；分支记录 forkEventId；
 *  - 回到任意旧事件时，用 replay(state, uptoEventId) 恢复当时的依赖版本。
 */

export function makeEvent(args: {
  projectId: string;
  branchId: string;
  seq: number;
  parentEventId: string | null;
  type: EventType;
  timestamp: number;
  actor: string;
  paramVersion: number | null;
  payload: unknown;
  summary: string;
}): GelEvent {
  const { projectId, branchId, seq, parentEventId, type, timestamp, actor, paramVersion, payload, summary } = args;
  const id = stableId('ev', [projectId, branchId, seq, parentEventId, type, timestamp, payload]);
  return { id, projectId, branchId, seq, parentEventId, type, timestamp, actor, paramVersion, payload, summary };
}

export function forkBranch(
  projectId: string,
  branches: BranchInfo[],
  name: string,
  parentBranchId: string,
  forkEventId: string,
  timestamp: number
): BranchInfo {
  const seq = branches.length;
  const id = stableId('br', [projectId, name, parentBranchId, forkEventId, seq]);
  return { id, projectId, name, parentBranchId, forkEventId, createdAt: timestamp };
}

/**
 * 分支的事件序列 = 父分支截至 forkEventId 的事件 + 本分支事件。
 * 本分支事件 seq 沿父链末端继续编号，保证全局稳定顺序。
 */
export function branchEvents(allEvents: GelEvent[], branch: BranchInfo): GelEvent[] {
  if (!branch.parentBranchId || !branch.forkEventId) {
    return allEvents
      .filter((e) => e.branchId === branch.id)
      .sort((a, b) => a.seq - b.seq);
  }
  const parent = { id: branch.parentBranchId } as BranchInfo;
  const parentChain = branchEvents(allEvents, parent);
  const upto = parentChain.filter((e) => e.seq <= parentChain.find((x) => x.id === branch.forkEventId)!.seq);
  const mine = allEvents.filter((e) => e.branchId === branch.id).sort((a, b) => a.seq - b.seq);
  return [...upto, ...mine];
}

export function nextSeq(events: GelEvent[]): number {
  return events.reduce((m, e) => Math.max(m, e.seq), 0) + 1;
}
