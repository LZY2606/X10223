import { contentId, canonical } from "./util.ts";

/** Immutable material: original evidence, never edited in place. */
export interface Material {
  id: string;
  kind: "gel-image" | "capture-meta" | "ladder-nominal" | "lane-boundary" | "band-center";
  version: number;
  supersedes: string | null;
  payload: unknown;
  createdByEvent: string;
}

/** Derived result: records input digest, parameter version and parent dependencies. */
export interface Derived {
  id: string;
  kind: "lane-curve" | "ruler" | "inference";
  paramVersion: string;
  inputDigest: string;
  parents: string[];
  status: "current" | "superseded";
  payload: unknown;
}

export interface EventRecord {
  id: string;
  seq: number;
  branchId: string;
  kind:
    | "import" | "compute" | "export" | "reopen"
    | "decision:accept" | "decision:reject" | "decision:param-adjust"
    | "source-change"
    | "judgment:smile-local-ruler"
    | "judgment:degraded-band-evidence";
  payload: unknown;
  parents: string[];
}

export interface Branch {
  id: string;
  name: string;
  parent: string | null;
  createdByEvent: string;
}

export const PARAM_VERSION = "gel-ruler/1.0 ruler=loglin-v1 smile=quad-v1 classify=deg-v1";

export function materialId(kind: Material["kind"], payload: unknown): string {
  return contentId("mat", { kind, payload });
}

export function derivedId(kind: Derived["kind"], inputDigest: string): string {
  return contentId("drv", { kind, inputDigest });
}

export function inputDigest(parents: string[], paramVersion: string): string {
  return contentId("dig", { parents: [...parents].sort(), paramVersion });
}

export function makeEvent(seq: number, branchId: string, kind: EventRecord["kind"], payload: unknown, parents: string[]): EventRecord {
  const id = contentId("evt", { seq, branchId, kind, payload, parents });
  return { id, seq, branchId, kind, payload, parents };
}

/**
 * Local invalidation: given a superseded material id, find exactly the derived
 * results whose parent chain contains it. Everything else keeps its identity.
 */
export function affectedBy(derived: Derived[], changedIds: Set<string>): Set<string> {
  const dirty = new Set<string>(changedIds);
  let grew = true;
  while (grew) {
    grew = false;
    for (const d of derived) {
      if (dirty.has(d.id)) continue;
      if (d.parents.some((p) => dirty.has(p))) {
        dirty.add(d.id);
        grew = true;
      }
    }
  }
  return dirty;
}

/** Stable ordering: equivalent inputs always produce the same sequence. */
export function stableSort<T extends { id: string; kind?: string }>(items: T[]): T[] {
  return [...items].sort((a, b) => {
    const ka = `${a.kind ?? ""}`.localeCompare(`${b.kind ?? ""}`);
    return ka !== 0 ? ka : a.id.localeCompare(b.id);
  });
}

/**
 * Replay: reconstruct the visible state at a given event sequence number.
 * Historical events keep the dependency versions visible at that time;
 * newer computations never overwrite history.
 */
export function replayState(events: EventRecord[], derived: Derived[], upToSeq: number): { events: EventRecord[]; derived: Derived[] } {
  const evs = events.filter((e) => e.seq <= upToSeq).sort((a, b) => a.seq - b.seq);
  const supersededAt = new Map<string, number>();
  for (const e of events.filter((e) => e.kind === "source-change").sort((a, b) => a.seq - b.seq)) {
    const p = e.payload as { supersededDerived?: string[] };
    for (const id of p.supersededDerived ?? []) supersededAt.set(id, e.seq);
  }
  const visible = derived.filter((d) => {
    const at = supersededAt.get(d.id);
    return at === undefined || at > upToSeq;
  });
  return { events: evs, derived: stableSort(visible) };
}

export function digestOfProject(materials: Material[], derived: Derived[], events: EventRecord[]): string {
  return contentId("prj", {
    materials: stableSort(materials).map((m) => m.id),
    derived: stableSort(derived).map((d) => [d.id, d.status]),
    events: [...events].sort((a, b) => a.seq - b.seq).map((e) => e.id),
  });
}
