import { describe, it, expect } from "vitest";
import { ingestCasepack, computeDerived, Budget } from "../src/domain/pipeline.ts";
import { makePack } from "./fixture.ts";

function run() {
  const ing = ingestCasepack(makePack(), { maxOps: 10000 } as Budget, 0);
  if (!ing.ok) throw new Error("ingest failed");
  const comp = computeDerived(ing.value, { maxOps: 10000 } as Budget, 1);
  if (!comp.ok) throw new Error("compute failed: " + JSON.stringify(comp.diagnostics));
  return comp.value;
}

describe("弯曲泳道 / 微笑效应 (smile)", () => {
  it("same height in different lanes != same molecular weight", () => {
    const comp = run();
    const s1b = comp.inferences.find((i) => i.bandId === "s1-b")!;
    const s4b = comp.inferences.find((i) => i.bandId === "s4-b")!;
    // both are 3000/2000 bp bands but smile corrections differ per lane
    expect(s1b.smileCorrection).not.toBeCloseTo(s4b.smileCorrection, 6);
    expect(s1b.dEff).not.toBeCloseTo(s4b.dEff, 1);
  });

  it("local ruler carries a validity region and emits machine-readable judgment", () => {
    const comp = run();
    const ev = comp.events.find((e) => e.kind === "judgment:smile-local-ruler");
    expect(ev).toBeDefined();
    const p = ev!.payload as any;
    expect(p.validRegion.unit).toBe("px");
    expect(p.validRegion.basis).toBe("image-norm");
    expect(p.validRegion.dMax).toBeGreaterThan(p.validRegion.dMin);
    expect(p.lanes.length).toBeGreaterThan(0);
  });

  it("band beyond ladder range becomes an interval, not a point", () => {
    const comp = run();
    const far = comp.inferences.find((i) => i.bandId === "s2-far")!;
    expect(far.value.kind).toBe("interval");
    expect((far.value as any).reason).toBe("outside-validity-region");
    expect(far.validRegion.dMax).toBeLessThan(far.dEff);
  });
});
