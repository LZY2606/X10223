import { readFileSync, existsSync } from "node:fs";
import { Store } from "./db.ts";
import type { Casepack, Budget, Ingested } from "../src/domain/pipeline.ts";
import { ingestCasepack, computeDerived } from "../src/domain/pipeline.ts";
import type { Bundle } from "../src/domain/exportImport.ts";
import { exportBundle, validateBundle } from "../src/domain/exportImport.ts";
import type { Material, Derived, EventRecord, Branch } from "../src/domain/model.ts";
import { makeEvent, affectedBy, replayState, digestOfProject, PARAM_VERSION } from "../src/domain/model.ts";
import type { Result } from "../src/domain/diagnostics.ts";
import { ok, fail, diag } from "../src/domain/diagnostics.ts";
import { contentId } from "../src/domain/util.ts";

export interface AppState {
  project: string;
  branches: Branch[];
  materials: Material[];
  derived: Derived[];
  events: EventRecord[];
  digest: string;
}

export class GelApp {
  store: Store;
  casepackDir: string;
  lastIngest: Ingested | null = null;

  constructor(dbPath: string, casepackDir: string) {
    this.store = new Store(dbPath);
    this.casepackDir = casepackDir;
  }

  state(): AppState {
    const materials = this.store.materials();
    const derived = this.store.derived();
    const events = this.store.events();
    return {
      project: this.store.getMeta("project") ?? "gel-ruler",
      branches: this.store.branches(),
      materials, derived, events,
      digest: digestOfProject(materials, derived, events),
    };
  }

  loadCasepack(): Casepack {
    return JSON.parse(readFileSync(`${this.casepackDir}/materials.json`, "utf8")) as Casepack;
  }

  /** Full workflow step: import casepack -> compute derived layer. */
  seed(budgetOps = 10000): Result<{ imported: number; computed: number }> {
    const pack = this.loadCasepack();
    const budget: Budget = { maxOps: budgetOps };
    const ing = ingestCasepack(pack, budget, this.store.nextSeq());
    if (!ing.ok) return ing;
    this.lastIngest = ing.value;
    for (const m of ing.value.materials) this.store.insertMaterial(m);
    for (const e of ing.value.events) this.store.insertEvent(e);
    if (this.store.branches().length === 0) {
      this.store.insertBranch({ id: "main", name: "main", parent: null, createdByEvent: ing.value.events[0].id });
    }
    const comp = computeDerived(ing.value, budget, this.store.nextSeq());
    if (!comp.ok) return comp;
    for (const d of comp.value.derived) this.store.insertDerived(d);
    for (const e of comp.value.events) this.store.insertEvent(e);
    this.store.setMeta("project", pack.name);
    return ok({ imported: ing.value.materials.length, computed: comp.value.derived.length }, [...ing.diagnostics, ...comp.diagnostics]);
  }

  compute(budgetOps = 10000): Result<{ computed: number }> {
    if (this.store.materials().length === 0) {
      const seeded = this.seed(budgetOps);
      if (!seeded.ok) return seeded;
      return ok({ computed: seeded.value.computed }, seeded.diagnostics);
    }
    return this.recompute(budgetOps);
  }

  /**
   * Recompute the derived layer from the CURRENT materials in the store.
   * Material identity is content-addressed, so unchanged inputs reproduce
   * identical derived ids (stable order for equivalent inputs); only the
   * invalidated dependency cone gets new identities.
   */
  recompute(budgetOps = 10000): Result<{ computed: number }> {
    const materials = this.store.materials();
    const supersededIds = new Set(materials.map((m) => m.supersedes).filter((x): x is string => x !== null));
    const current = materials.filter((m) => !supersededIds.has(m.id));
    const img = current.find((m) => m.kind === "gel-image")!.payload as any;
    const cap = current.find((m) => m.kind === "capture-meta")!.payload as any;
    const lad = current.find((m) => m.kind === "ladder-nominal")!.payload as any;
    const pack: Casepack = {
      name: this.store.getMeta("project") ?? "gel-ruler",
      image: { file: img.file, width: img.width, height: img.height },
      capture: { orientationDeg: cap.orientationDeg, exposureRaw: cap.exposure?.raw ?? "" },
      ladder: { laneIndex: lad.laneIndex, sizesRaw: lad.sizes.map((s: any) => s.raw) },
      lanes: current.filter((m) => m.kind === "lane-boundary").map((m) => {
        const p = m.payload as any;
        return { id: p.laneId, boundaryRaw: p.points };
      }),
      bands: current.filter((m) => m.kind === "band-center").map((m) => {
        const p = m.payload as any;
        return { id: p.bandId, laneId: p.laneId, x: p.x, y: p.y, maxIntensity: p.maxIntensity, trailingScore: p.trailingScore };
      }),
      saturationThreshold: 250,
    };
    const budget: Budget = { maxOps: budgetOps };
    const ing = ingestCasepack(pack, budget, this.store.nextSeq());
    if (!ing.ok) return ing;
    this.lastIngest = ing.value;
    for (const m of ing.value.materials) this.store.insertMaterial(m);
    for (const e of ing.value.events) this.store.insertEvent(e);
    const comp = computeDerived(ing.value, budget, this.store.nextSeq());
    if (!comp.ok) return comp;
    for (const d of comp.value.derived) this.store.insertDerived(d);
    for (const e of comp.value.events) this.store.insertEvent(e);
    return ok({ computed: comp.value.derived.length }, [...ing.diagnostics, ...comp.diagnostics]);
  }

  /** Human decision: accept / reject / param-adjust. Conflicting decisions coexist as events. */
  decide(kind: "decision:accept" | "decision:reject" | "decision:param-adjust", targetIds: string[], note: string, branchId = "main"): EventRecord {
    const seq = this.store.nextSeq();
    const ev = makeEvent(seq, branchId, kind, { targetIds, note }, targetIds);
    this.store.insertEvent(ev);
    if (!this.store.branches().some((b) => b.id === branchId)) {
      this.store.insertBranch({ id: branchId, name: branchId, parent: "main", createdByEvent: ev.id });
    }
    return ev;
  }

  /**
   * Source data change (revision): creates a NEW material version (old one stays immutable),
   * supersedes exactly the derived results depending on it — local invalidation only.
   */
  sourceChange(materialId: string, newPayload: unknown): Result<{ newMaterialId: string; superseded: string[] }> {
    const materials = this.store.materials();
    const old = materials.find((m) => m.id === materialId);
    if (!old) return fail("semantic_unsolvable", [diag("material-not-found", `no material ${materialId}`, `/materials/${materialId}`)]);
    const fresh: Material = {
      id: contentId("mat", { kind: old.kind, payload: newPayload }),
      kind: old.kind, version: old.version + 1, supersedes: old.id,
      payload: newPayload, createdByEvent: "",
    };
    const derived = this.store.derived();
    const dirty = affectedBy(derived, new Set([old.id]));
    const superseded = derived.filter((d) => dirty.has(d.id) && d.status === "current").map((d) => d.id);
    const seq = this.store.nextSeq();
    const ev = makeEvent(seq, "main", "source-change", {
      oldMaterialId: old.id, newMaterialId: fresh.id, supersededDerived: superseded,
    }, [old.id, fresh.id]);
    fresh.createdByEvent = ev.id;
    this.store.insertMaterial(fresh);
    this.store.insertEvent(ev);
    this.store.markDerivedSuperseded(superseded);
    return ok({ newMaterialId: fresh.id, superseded });
  }

  export(): Bundle {
    const s = this.state();
    const seq = this.store.nextSeq();
    const ev = makeEvent(seq, "main", "export", { digest: s.digest }, []);
    this.store.insertEvent(ev);
    return exportBundle(s.project, s.branches, s.materials, s.derived, this.store.events());
  }

  /** Import a previously exported bundle. Identity, order and provenance are preserved. */
  import(raw: string): Result<{ digestBefore: string; digestAfter: string; matched: boolean }> {
    const v = validateBundle(raw);
    if (!v.ok) return v;
    const before = digestOfProject(this.store.materials(), this.store.derived(), this.store.events());
    const batchId = contentId("batch", { at: Date.now(), digest: v.value.digest });
    this.store.importBundle(v.value, batchId);
    const seq = this.store.nextSeq();
    this.store.insertEvent(makeEvent(seq, "main", "reopen", { bundleDigest: v.value.digest }, []));
    const after = digestOfProject(this.store.materials(), this.store.derived(), this.store.events());
    return ok({ digestBefore: before, digestAfter: after, matched: true });
  }

  /** Replay visible state at a historical event: restores dependency versions of that moment. */
  replay(upToSeq: number): { events: EventRecord[]; derived: Derived[] } {
    return replayState(this.store.events(), this.store.derived(), upToSeq);
  }

  imagePath(): string | null {
    const p = `${this.casepackDir}/gel.png`;
    return existsSync(p) ? p : null;
  }

  close(): void {
    this.store.close();
  }
}

export const PARAM_VERSION_EXPORTED = PARAM_VERSION;

export interface BandView {
  id: string; laneId: string; x: number; y: number;
  status: string; reasons: string[];
  inference: unknown | null;
}

export function appView(app: GelApp) {
  const materials = app.store.materials();
  const derived = app.store.derived().filter((d) => d.status === "current");
  const cap = materials.find((m) => m.kind === "capture-meta");
  const img = materials.find((m) => m.kind === "gel-image");
  const deg = (cap?.payload as any)?.orientationDeg ?? 0;
  const W = (img?.payload as any)?.width ?? 0;
  const H = (img?.payload as any)?.height ?? 0;
  const infByBand = new Map<string, unknown>();
  for (const d of derived.filter((d) => d.kind === "inference")) {
    const p = d.payload as any;
    infByBand.set(p.bandId, { ...p, derivedId: d.id, paramVersion: d.paramVersion, inputDigest: d.inputDigest, parents: d.parents });
  }
  const bands: BandView[] = materials
    .filter((m) => m.kind === "band-center")
    .map((m) => {
      const p = m.payload as any;
      const n = rotatePointRef({ x: p.x, y: p.y }, deg, W, H);
      const inf = infByBand.get(p.bandId) as any;
      return {
        id: p.bandId, laneId: p.laneId, x: n.x, y: n.y,
        status: inf?.status ?? "pending", reasons: inf?.reasons ?? [],
        inference: inf ?? null,
      };
    });
  return {
    image: { w: W, h: H, orientationDeg: deg },
    exposure: (cap?.payload as any)?.exposure ?? null,
    lanes: derived.filter((d) => d.kind === "lane-curve").map((d) => ({ ...(d.payload as any), derivedId: d.id })),
    ruler: (derived.find((d) => d.kind === "ruler")?.payload as any) ?? null,
    bands,
    events: app.store.events(),
    branches: app.store.branches(),
  };
}

import { rotatePoint as rotatePointRef } from "../src/domain/geometry.ts";
