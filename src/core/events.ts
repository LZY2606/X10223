import { contentHash } from "./hash.js";
import type { Event, EventPayload, ProjectMeta } from "./types.js";

/**
 * 事件 id 基于内容（project、seq、branch、父链、负载），
 * 但不包含自身 id（避免自引用）。同一项目中重放得到同一批 id。
 */
export function computeEventId(e: Omit<Event, "id">): string {
  return `evt_${contentHash({
    projectId: e.projectId,
    seq: e.seq,
    branch: e.branch,
    parentIds: e.parentIds,
    payload: e.payload,
    at: e.at,
  }).slice(0, 20)}`;
}

export interface EventInput {
  branch: string;
  parentIds: string[];
  payload: EventPayload;
  at: number;
}

/** 确定性事件追加器：在分支上按顺序分配 seq 并计算内容 id */
export class EventLog {
  private byId = new Map<string, Event>();
  private byBranch = new Map<string, Event[]>();

  constructor(events: Event[] = []) {
    for (const e of events) this.addExisting(e);
  }

  private addExisting(e: Event): void {
    this.byId.set(e.id, e);
    const list = this.byBranch.get(e.branch) ?? [];
    list.push(e);
    this.byBranch.set(e.branch, list);
  }

  get size(): number {
    return this.byId.size;
  }

  get(id: string): Event | undefined {
    return this.byId.get(id);
  }

  all(): Event[] {
    return [...this.byId.values()];
  }

  branchEvents(branch: string): Event[] {
    return [...(this.byBranch.get(branch) ?? [])].sort((a, b) => a.seq - b.seq);
  }

  branches(): string[] {
    return [...this.byBranch.keys()].sort();
  }

  /** 校验父链存在性（根事件除外），返回第一条错误 */
  validateParentRefs(): string | null {
    for (const e of this.byId.values()) {
      if (e.seq !== 1 && e.parentIds.length === 0) return `事件 ${e.id} 缺少父事件`;
      for (const pid of e.parentIds) {
        if (!this.byId.has(pid)) return `事件 ${e.id} 引用了不存在的父事件 ${pid}`;
      }
    }
    return null;
  }

  nextSeq(branch: string): number {
    return (this.byBranch.get(branch)?.length ?? 0) + 1;
  }

  append(projectId: string, input: EventInput): Event {
    const seq = this.nextSeq(input.branch);
    const provisional: Omit<Event, "id"> = {
      projectId,
      seq,
      branch: input.branch,
      parentIds: input.parentIds,
      payload: input.payload,
      at: input.at,
    };
    const event: Event = { id: computeEventId(provisional), ...provisional };
    if (this.byId.has(event.id)) {
      throw new Error(`事件哈希冲突（重复追加同一内容）: ${event.id}`);
    }
    this.addExisting(event);
    return event;
  }

  /** 从已存在的有序事件重建（用于导入），保留原 id 并校验内容一致性 */
  static restore(events: Event[]): EventLog {
    const log = new EventLog();
    const seen = new Set<string>();
    const seqSeen = new Map<string, Set<number>>();
    for (const e of events) {
      const { id, ...rest } = e;
      const expected = computeEventId(rest);
      if (id !== expected) {
        throw new Error(`事件 ${id} 的内容哈希与负载不一致（应为 ${expected}）`);
      }
      if (seen.has(id)) throw new Error(`重复事件 id: ${id}`);
      seen.add(id);
      const bk = `${e.projectId}/${e.branch}`;
      const seqSet = seqSeen.get(bk) ?? new Set<number>();
      if (seqSet.has(e.seq)) throw new Error(`分支 ${e.branch} 上 seq ${e.seq} 重复`);
      seqSet.add(e.seq);
      seqSeen.set(bk, seqSet);
      log.addExisting(e);
    }
    const refErr = log.validateParentRefs();
    if (refErr) throw new Error(refErr);
    return log;
  }

  /** 以拓扑顺序（祖先在前）导出全部事件；同祖先深度内按 (branch, seq) 稳定排序 */
  topoSorted(): Event[] {
    const indeg = new Map<string, number>();
    const children = new Map<string, string[]>();
    for (const e of this.byId.values()) {
      indeg.set(e.id, e.parentIds.length);
      for (const p of e.parentIds) {
        const arr = children.get(p) ?? [];
        arr.push(e.id);
        children.set(p, arr);
      }
    }
    const roots = [...this.byId.values()]
      .filter((e) => e.parentIds.length === 0)
      .sort((a, b) => a.seq - b.seq || a.branch.localeCompare(b.branch))
      .map((e) => e.id);
    const out: Event[] = [];
    const queue = [...roots];
    while (queue.length) {
      const id = queue.shift()!;
      const e = this.byId.get(id)!;
      out.push(e);
      for (const cid of children.get(id) ?? []) {
        indeg.set(cid, indeg.get(cid)! - 1);
        if (indeg.get(cid) === 0) queue.push(cid);
      }
      queue.sort((a, b) => {
        const ea = this.byId.get(a)!;
        const eb = this.byId.get(b)!;
        return ea.seq - eb.seq || ea.branch.localeCompare(eb.branch);
      });
    }
    if (out.length !== this.byId.size) throw new Error("事件图存在环或断裂，无法拓扑排序");
    return out;
  }
}

/** 计算一个视图（as-of 某个事件）所需的祖先事件集合 */
export function ancestorClosure(log: EventLog, eventId: string): Event[] {
  const out: Event[] = [];
  const visited = new Set<string>();
  const walk = (id: string): void => {
    if (visited.has(id)) return;
    visited.add(id);
    const e = log.get(id);
    if (!e) throw new Error(`祖先链断裂：${id}`);
    for (const p of e.parentIds) walk(p);
    out.push(e);
  };
  walk(eventId);
  return out.sort((a, b) => a.at - b.at || a.seq - b.seq);
}

let clock = 1_758_000_000_000; // 固定基准时钟（2025-09-16 附近），供案例包确定性生成
export function tickClock(stepMs = 60_000): number {
  clock += stepMs;
  return clock;
}

export function projectIdentity(name: string, createdAt: number): Pick<ProjectMeta, "id"> {
  return { id: `prj_${contentHash({ name, createdAt }).slice(0, 12)}` };
}
