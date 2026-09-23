import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { Casepack, ingestCasepack, computeDerived, Budget } from "../src/domain/pipeline.ts";

describe("离线案例包 gel-ruler", () => {
  it("ingests and computes with judgment events", () => {
    const pack = JSON.parse(readFileSync("casepack/gel-ruler/materials.json", "utf8")) as Casepack;
    const ing = ingestCasepack(pack, { maxOps: 100000 } as Budget, 0);
    expect(ing.ok).toBe(true);
    if (!ing.ok) return;
    const comp = computeDerived(ing.value, { maxOps: 100000 } as Budget, 1);
    expect(comp.ok).toBe(true);
    if (!comp.ok) return;
    expect(comp.value.inferences.length).toBe(pack.bands.length);
    const kinds = new Set(comp.value.events.map((e) => e.kind));
    expect(kinds.has("judgment:smile-local-ruler")).toBe(true);
    expect(kinds.has("judgment:degraded-band-evidence")).toBe(true);
    // every derived result records input digest, param version and parents
    for (const d of comp.value.derived) {
      expect(d.inputDigest.length).toBeGreaterThan(8);
      expect(d.paramVersion).toContain("gel-ruler/1.0");
      expect(d.parents.length).toBeGreaterThan(0);
    }
  });
});
