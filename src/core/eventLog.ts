import type { Branch, Event } from '../shared/model.js';
import { corrupted, impossible } from '../shared/errors.js';

export interface EventLog {
  project: { id: string; name: string; createdAt: string; description: string };
  branches: Branch[];
  events: Event[];
}

export function assertWellFormed(log: EventLog): void {
  if (!log || typeof log !== 'object') throw corrupted('BUNDLE-NOT-OBJECT', '案例数据不是对象');
  if (!log.project?.id) throw corrupted('PROJECT-ID-MISSING', '缺少项目 id', { path: 'project.id' });
  if (!Array.isArray(log.branches) || !Array.isArray(log.events)) {
    throw corrupted('LOG-ARRAYS-MISSING', 'branches/events 必须是数组', { path: '' });
  }
  const branchIds = new Set<string>();
  for (const branch of log.branches) {
    if (!branch.id) throw corrupted('BRANCH-ID-MISSING', '分支缺少 id', { path: 'branches[].id' });
    if (branchIds.has(branch.id)) throw corrupted('BRANCH-ID-DUPLICATE', `分支 id 重复: ${branch.id}`, { branch: branch.id });
    branchIds.add(branch.id);
  }
  const eventIds = new Set<string>();
  const perBranchSeq = new Map<string, number>();
  for (const event of log.events) {
    if (!event.id) throw corrupted('EVENT-ID-MISSING', '事件缺少 id', { path: 'events[].id' });
    if (eventIds.has(event.id)) throw corrupted('EVENT-ID-DUPLICATE', `事件 id 重复: ${event.id}`, { eventId: event.id });
    eventIds.add(event.id);
    if (!branchIds.has(event.branch)) {
      throw corrupted('EVENT-DANGLING-BRANCH', `事件 ${event.id} 引用了不存在的分支 ${event.branch}`, {
        eventId: event.id,
        branch: event.branch,
      });
    }
    const expected = (perBranchSeq.get(event.branch) ?? 0) + 1;
    if (event.seq !== expected) {
      throw corrupted(
        'EVENT-SEQ-GAP',
        `分支 ${event.branch} 事件序号不连续：期望 ${expected}，实际 ${event.seq}（事件 ${event.id}）`,
        { eventId: event.id, branch: event.branch },
      );
    }
    perBranchSeq.set(event.branch, expected);
    if (event.parentEventId && !eventIds.has(event.parentEventId)) {
      throw corrupted('EVENT-DANGLING-PARENT', `事件 ${event.id} 的父事件 ${event.parentEventId} 不存在`, {
        eventId: event.id,
        path: 'parentEventId',
      });
    }
  }
  for (const branch of log.branches) {
    if (branch.parentBranch && !branchIds.has(branch.parentBranch)) {
      throw impossible('BRANCH-PARENT-UNKNOWN', `分支 ${branch.id} 的父分支不存在`, { branch: branch.id });
    }
    if (branch.headEventId && !eventIds.has(branch.headEventId)) {
      throw corrupted('BRANCH-HEAD-DANGLING', `分支 ${branch.id} 的 head 事件不存在`, { branch: branch.id });
    }
  }
}

export function eventsOfBranch(log: EventLog, branchId: string): Event[] {
  return log.events.filter((e) => e.branch === branchId).sort((a, b) => a.seq - b.seq);
}
