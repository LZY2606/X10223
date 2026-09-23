import { describe, it, expect } from "vitest";
import { ingestCasepack, computeDerived, Budget } from "../src/domain/pipeline.ts";
import { makePack, LADDER_BP } from "./fixture.ts";

describe("ladder 缺带与非单调标尺", () => {
  it("missing ladder band -> positioned warning, rest still usable", () => {
    const pack = makePack();
    // remove the 5000bp band from the ladder lane
    pack.bands = pack.bands.filter((b) => b.id !== "lad-3");
    const ing = ingestCasepack(pack, { maxOps: 10000 } as Budget, 0);
    expect(ing.ok).toBe(true);
    if (!ing.ok) return;
    const comp = computeDerived(ing.value, { maxOps: 10000 } as Budget, 1);
    expect(comp.ok).toBe(true);
    if (!comp.ok) return;
    const warn = comp.diagnostics.find((d) => d.code === "ladder-band-missing");
    expect(warn).toBeDefined();
    expect(warn!.path).toBe("/ladder");
    // ruler still fitted from remaining points
    expect(comp.value.rulers.length).toBe(1);
  });

  it("non-monotonic ladder -> semantic_unsolvable, distinct from format_corrupt", () => {
    const swapped = [...LADDER_BP];
    [swapped[2], swapped[5]] = [swapped[5], swapped[2]];
    const pack = makePack({ ladderSizes: swapped });
    const ing = ingestCasepack(pack, { maxOps: 10000 } as Budget, 0);
    expect(ing.ok).toBe(true);
    if (!ing.ok) return;
    const comp = computeDerived(ing.value, { maxOps: 10000 } as Budget, 1);
    expect(comp.ok).toBe(false);
    if (comp.ok) return;
    expect(comp.kind).toBe("semantic_unsolvable");
    expect(comp.diagnostics[0].code).toBe("ruler-non-monotonic");
    expect(comp.diagnostics[0].path).toContain("/ladder");
  });

  it("incomplete input -> positioned diagnostics, no silent defaults", () => {
    const pack = makePack();
    pack.capture.exposureRaw = "not-a-quantity";
    const ing = ingestCasepack(pack, { maxOps: 10000 } as Budget, 0);
    expect(ing.ok).toBe(false);
    if (ing.ok) return;
    expect(ing.kind).toBe("format_corrupt");
    expect(ing.diagnostics[0].path).toBe("/capture/exposure");
  });
});
