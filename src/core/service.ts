import { randomUUID } from 'node:crypto';
import type {
  Branch,
  Event,
  ImageMaterial,
  ParameterName,
  ParameterRevision,
} from '../shared/model.js';
import { deterministicId } from '../shared/ids.js';
import { exhausted, impossible } from '../shared/errors.js';
import { PARAMETER_NAMES, defaultParameters } from './parameters.js';
import type { EventLog } from './eventLog.js';
import { assertWellFormed } from './eventLog.js';

export interface ResourceBudget {
  maxEvents: number;
  maxBlobs: number;
  maxBlobBytes: number;
}

export const DEFAULT_BUDGET: ResourceBudget = {
  maxEvents: 200_000,
  maxBlobs: 10_000,
  maxBlobBytes: 256 * 1024 * 1024,
};

export interface CreateProjectInput {
  name: string;
  description?: string;
  now?: string;
}

function nowIso(now?: string): string {
  return now ?? new Date('2026-09-23T00:00:00Z').toISOString();
}

export function createProject(input: CreateProjectInput): EventLog {
  if (!input.name || !input.name.trim()) {
    throw impossible('PROJECT-NAME-EMPTY', '项目名称缺失：无法在不伪造默认值的情况下创建项目', {
      path: 'name',
    });
  }
  const timestamp = nowIso(input.now);
  const projectId = deterministicId('proj', input.name.trim(), timestamp);
  const mainId = `br_main`;
  const event: Event = {
    id: deterministicId('ev', projectId, mainId, 1, 'project-created'),
    seq: 1,
    branch: mainId,
    parentEventId: null,
    timestamp,
    kind: 'project-created',
    actor: 'system',
    payload: { name: input.name.trim(), description: input.description ?? '' },
    parents: [],
  };
  const branch: Branch = {
    id: mainId,
    name: '主叙事',
    parentBranch: null,
    forkedFromEventId: null,
    headEventId: event.id,
    createdAt: timestamp,
  };
  return {
    project: { id: projectId, name: input.name.trim(), createdAt: timestamp, description: input.description ?? '' },
    branches: [branch],
    events: [event],
  };
}

export interface AppendContext {
  log: EventLog;
  branch: string;
  actor?: Event['actor'];
  now?: string;
  budget?: ResourceBudget;
}

export function appendEvent(
  ctx: AppendContext,
  kind: Event['kind'],
  payload: Record<string, unknown>,
  options: { inputSummary?: Record<string, unknown>; parents?: string[]; paramVersionId?: string | null; deterministic?: boolean } = {},
): Event {
  const budget = ctx.budget ?? DEFAULT_BUDGET;
  if (ctx.log.events.length >= budget.maxEvents) {
    throw exhausted('BUDGET-EVENTS', `事件数量超出资源预算 ${budget.maxEvents}`, { count: ctx.log.events.length });
  }
  const branch = ctx.log.branches.find((b) => b.id === ctx.branch);
  if (!branch) throw impossible('BRANCH-NOT-FOUND', `分支不存在: ${ctx.branch}`, { branch: ctx.branch });
  const seq = ctx.log.events.filter((e) => e.branch === ctx.branch).length + 1;
  const timestamp = nowIso(ctx.now);
  const branchEvents = ctx.log.events.filter((e) => e.branch === ctx.branch);
  const parentEventId = branchEvents.length ? branchEvents[branchEvents.length - 1]!.id : null;
  const id =
    options.deterministic === false
      ? `ev_${randomUUID()}`
      : deterministicId('ev', ctx.log.project.id, ctx.branch, seq, kind, payload);
  const event: Event = {
    id,
    seq,
    branch: ctx.branch,
    parentEventId,
    timestamp,
    kind,
    actor: ctx.actor ?? 'reviewer',
    payload,
    inputSummary: options.inputSummary,
    paramVersionId: options.paramVersionId ?? null,
    parents: options.parents ?? (parentEventId ? [parentEventId] : []),
  };
  ctx.log.events.push(event);
  branch.headEventId = event.id;
  return event;
}

export function forkBranch(
  log: EventLog,
  fromBranch: string,
  newBranchId: string,
  name: string,
  atEventId?: string,
  now?: string,
): { branch: Branch; event: Event } {
  if (log.branches.some((b) => b.id === newBranchId)) {
    throw impossible('BRANCH-EXISTS', `分支已存在: ${newBranchId}`, { branch: newBranchId });
  }
  const sourceEvents = log.events.filter((e) => e.branch === fromBranch).sort((a, b) => a.seq - b.seq);
  const atEvent = atEventId ? sourceEvents.find((e) => e.id === atEventId) : sourceEvents[sourceEvents.length - 1];
  if (!atEvent) throw impossible('FORK-POINT-MISSING', '无法在空分支上创建分叉', { branch: fromBranch });
  const ancestors = sourceEvents.filter((e) => e.seq <= atEvent.seq).map((e) => ({ ...e }));
  const timestamp = nowIso(now);
  const copied: Event[] = ancestors;
  const createSeq = copied.length + 1;
  const createEvent: Event = {
    id: deterministicId('ev', log.project.id, newBranchId, createSeq, 'branch-created', { from: fromBranch }),
    seq: createSeq,
    branch: newBranchId,
    parentEventId: copied[copied.length - 1]!.id,
    timestamp,
    kind: 'branch-created',
    actor: 'reviewer',
    payload: { fromBranch, fromEventId: atEvent.id },
    parents: [copied[copied.length - 1]!.id],
  };
  copied.push(createEvent);
  const branch: Branch = {
    id: newBranchId,
    name,
    parentBranch: fromBranch,
    forkedFromEventId: atEvent.id,
    headEventId: createEvent.id,
    createdAt: timestamp,
  };
  log.branches.push(branch);
  log.events.push(...copied);
  return { branch, event: createEvent };
}


export function reviseParameter(
  ctx: AppendContext,
  name: ParameterName,
  newValue: number | string | boolean,
  reason: string,
  current: Record<ParameterName, number | string | boolean>,
): Event {
  if (!PARAMETER_NAMES.includes(name)) {
    throw impossible('PARAM-UNKNOWN', `未知参数: ${name}`, { path: `parameters.${name}` });
  }
  if (!reason.trim()) {
    throw impossible('PARAM-REASON-EMPTY', '参数修订必须给出理由，不允许无出处的覆盖', { path: 'parameter-revision.reason' });
  }
  const revision: ParameterRevision = { name, oldValue: current[name] ?? null, newValue, reason };
  return appendEvent(ctx, 'parameter-revised', { revision }, {
    inputSummary: { parameter: name, old: revision.oldValue, new: newValue },
  });
}

export { assertWellFormed, defaultParameters };
export type { EventLog };
export function checkBlobBudget(blob: ImageMaterial, budget: ResourceBudget): void {
  if (blob.bytes > budget.maxBlobBytes) {
    throw exhausted('BUDGET-BLOB-BYTES', `图像 ${blob.blobId} 超出单文件预算 ${budget.maxBlobBytes} 字节`, {
      blobId: blob.blobId,
      bytes: blob.bytes,
    });
  }
}
