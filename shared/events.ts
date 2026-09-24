// 事件工厂：seq 为全局稳定顺序；分支在父事件分叉时派生；旧事件不可变。
import type {
  BandDecision,
  Event,
  GelParams,
  Material,
  MaterialKind
} from "./types";
import { sha256Text } from "./hash";
import { canonicalJson } from "./canonical";
import { PARAMS_V1 } from "./defaults";

let clockSeq = 0;
export function deterministicIso(seq: number): string {
  return `2026-09-25T0${Math.min(9, 1 + Math.floor(seq / 6))}:${String(seq % 60).padStart(2, "0")}:00+09:00`;
}

export interface EventContext {
  caseId: string;
  nextSeq: number;
  parentId: string | null;
  branch: string;
  paramsVersion: string;
  actor?: string;
}

function eventId(type: string, caseId: string, seq: number, parentId: string | null, payload: unknown): string {
  return `evt_${sha256Text(
    canonicalJson({ type, caseId, seq, parentId, payload })
  ).slice(0, 18)}`;
}

export function makeEvent<T extends Event>(
  type: T["type"],
  ctx: EventContext,
  payload: T["payload"],
  overrides?: { at?: string; branch?: string }
): T {
  const seq = ctx.nextSeq;
  const branch = overrides?.branch ?? ctx.branch;
  const at = overrides?.at ?? deterministicIso(seq);
  const base = {
    id: eventId(type, ctx.caseId, seq, ctx.parentId, payload),
    caseId: ctx.caseId,
    seq,
    parentId: ctx.parentId,
    branch,
    at,
    actor: ctx.actor ?? "reviewer",
    paramsVersion: ctx.paramsVersion
  };
  return { ...base, type, payload } as T;
}

export class EventBuilder {
  events: Event[] = [];
  caseId: string;
  branch: string;
  parentId: string | null = null;
  paramsVersion = PARAMS_V1;
  actor = "reviewer";
  private seq = 0;

  constructor(caseId: string, branch = "main") {
    this.caseId = caseId;
    this.branch = branch;
  }

  get nextSeq(): number {
    return this.seq;
  }

  head(): string | null {
    return this.parentId;
  }

  private ctx(): EventContext {
    return {
      caseId: this.caseId,
      nextSeq: this.seq,
      parentId: this.parentId,
      branch: this.branch,
      paramsVersion: this.paramsVersion,
      actor: this.actor
    };
  }

  private append(event: Event): Event {
    this.events.push(event);
    this.seq = event.seq + 1;
    this.parentId = event.id;
    return event;
  }

  createCase(title: string, scenario: string, note: string) {
    return this.append(makeEvent<Extract<Event, { type: "case_created" }>>(
      "case_created",
      this.ctx(),
      { title, scenario, note }
    ));
  }

  add(material: Material) {
    return this.append(makeEvent<Extract<Event, { type: "material_added" }>>(
      "material_added",
      this.ctx(),
      { material }
    ));
  }

  revise(kind: MaterialKind, materialId: string, changedField: string, from: unknown, to: unknown, material: Material) {
    return this.append(makeEvent<Extract<Event, { type: "material_revised" }>>(
      "material_revised",
      this.ctx(),
      { kind, materialId, changedField, from, to, material }
    ));
  }

  reviseParams(fromVersion: string, params: GelParams, reason: string) {
    this.paramsVersion = params.version;
    return this.append(makeEvent<Extract<Event, { type: "params_revised" }>>(
      "params_revised",
      this.ctx(),
      { fromVersion, params, reason }
    ));
  }

  decide(decision: BandDecision) {
    return this.append(makeEvent<Extract<Event, { type: "band_decided" }>>(
      "band_decided",
      this.ctx(),
      { decision }
    ));
  }

  /** 从指定父事件分叉出新分支；seq 在全局继续编号，保证等价输入稳定顺序 */
  fork(branchName: string, fromEventId?: string): EventBuilder {
    const fork = new EventBuilder(this.caseId, branchName);
    fork.actor = this.actor;
    fork.paramsVersion = this.paramsVersion;
    fork.seq = this.seq;
    fork.events = [...this.events];
    fork.parentId = fromEventId ?? this.parentId;
    return fork;
  }
}

export function eventsUpTo(events: Event[], eventId: string): Event[] {
  const byId = new Map(events.map((e) => [e.id, e]));
  const out: Event[] = [];
  let cur = byId.get(eventId);
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.push(cur);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return out.sort((a, b) => a.seq - b.seq);
}

export function advanceSeq(events: Event[]): number {
  return events.reduce((max, e) => Math.max(max, e.seq + 1), 0);
}
