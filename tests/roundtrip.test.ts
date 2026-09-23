import { describe, it, expect } from "vitest";
import { GelApp } from "../server/app.ts";

describe("导出/导入往返 (export-import round trip)", () => {
  it("identity, order and provenance survive export -> wipe -> import", () => {
    const a = new GelApp(":memory:", "casepack/gel-ruler");
    expect(a.seed().ok).toBe(true);
    a.decide("decision:accept", ["s1-a"], "looks clean", "main");
    a.decide("decision:reject", ["s2-sat"], "saturated, cannot trust", "review-b");
    const bundle = a.export();
    const aState = a.state();
    a.close();

    const b = new GelApp(":memory:", "casepack/gel-ruler");
    const r = b.import(JSON.stringify(bundle));
    expect(r.ok).toBe(true);
    const bState = b.state();

    // identities preserved
    expect(bState.materials.map((m) => m.id).sort()).toEqual(aState.materials.map((m) => m.id).sort());
    expect(bState.derived.map((d) => `${d.id}:${d.status}`).sort()).toEqual(aState.derived.map((d) => `${d.id}:${d.status}`).sort());
    // event order and provenance (parents) preserved
    const aEv = aState.events.map((e) => [e.seq, e.id, e.kind]);
    const bEv = bState.events.filter((e) => e.kind !== "reopen").map((e) => [e.seq, e.id, e.kind]);
    expect(bEv).toEqual(aEv);
    for (const e of aState.events) {
      const inB = bState.events.find((x) => x.id === e.id)!;
      expect(inB.parents).toEqual(e.parents);
      expect(inB.branchId).toBe(e.branchId);
    }
    // branches preserved
    expect(bState.branches.map((x) => x.id).sort()).toEqual(aState.branches.map((x) => x.id).sort());
    // derived results keep input digest + param version + parents
    for (const d of aState.derived) {
      const inB = bState.derived.find((x) => x.id === d.id)!;
      expect(inB.inputDigest).toBe(d.inputDigest);
      expect(inB.paramVersion).toBe(d.paramVersion);
      expect(inB.parents).toEqual(d.parents);
    }
    b.close();
  });

  it("equivalent inputs give stable identity and order", () => {
    const a = new GelApp(":memory:", "casepack/gel-ruler");
    const b = new GelApp(":memory:", "casepack/gel-ruler");
    a.seed(); b.seed();
    expect(a.state().derived.map((d) => d.id)).toEqual(b.state().derived.map((d) => d.id));
    expect(a.state().events.map((e) => e.id)).toEqual(b.state().events.map((e) => e.id));
    a.close(); b.close();
  });
});
