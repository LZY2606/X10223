import { describe, it, expect } from "vitest";
import { ingestCasepack, computeDerived, Budget } from "../src/domain/pipeline.ts";
import { validateBundle } from "../src/domain/exportImport.ts";
import { makePack, LADDER_BP } from "./fixture.ts";

describe("三种失败必须可区分", () => {
  it("budget_exhausted", () => {
    const ing = ingestCasepack(makePack(), { maxOps: 2 } as Budget, 0);
    expect(ing.ok).toBe(false);
    if (ing.ok) return;
    expect(ing.kind).toBe("budget_exhausted");
  });

  it("budget_exhausted during compute", () => {
    const ing = ingestCasepack(makePack(), { maxOps: 10000 } as Budget, 0);
    if (!ing.ok) throw new Error("ingest failed");
    const comp = computeDerived(ing.value, { maxOps: 3 } as Budget, 1);
    expect(comp.ok).toBe(false);
    if (comp.ok) return;
    expect(comp.kind).toBe("budget_exhausted");
  });

  it("format_corrupt", () => {
    const r = validateBundle("{not json");
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.kind).toBe("format_corrupt");
  });

  it("semantic_unsolvable", () => {
    const swapped = [...LADDER_BP];
    [swapped[0], swapped[7]] = [swapped[7], swapped[0]];
    const ing = ingestCasepack(makePack({ ladderSizes: swapped }), { maxOps: 10000 } as Budget, 0);
    if (!ing.ok) throw new Error("ingest failed");
    const comp = computeDerived(ing.value, { maxOps: 10000 } as Budget, 1);
    expect(comp.ok).toBe(false);
    if (comp.ok) return;
    expect(comp.kind).toBe("semantic_unsolvable");
  });
});
