import { describe, it, expect } from "vitest";
import { ingestCasepack, computeDerived, Budget } from "../src/domain/pipeline.ts";
import { makePack } from "./fixture.ts";

function run() {
  const ing = ingestCasepack(makePack(), { maxOps: 10000 } as Budget, 0);
  if (!ing.ok) throw new Error("ingest failed");
  const comp = computeDerived(ing.value, { maxOps: 10000 } as Budget, 1);
  if (!comp.ok) throw new Error("compute failed");
  return comp.value;
}

describe("饱和区 / 拖尾 / 重叠条带", () => {
  it("saturated band can only be a candidate", () => {
    const comp = run();
    const sat = comp.inferences.find((i) => i.bandId === "s2-sat")!;
    expect(sat.status).toBe("candidate");
    expect(sat.reasons).toContain("saturated");
    expect(sat.value.kind).not.toBe("point");
    const ev = comp.events.find((e) => e.kind === "judgment:degraded-band-evidence" && (e.payload as any).bandId === "s2-sat");
    expect(ev).toBeDefined();
    expect((ev!.payload as any).rule).toContain("candidate or interval");
  });

  it("trailing band can only be a candidate", () => {
    const comp = run();
    const t = comp.inferences.find((i) => i.bandId === "s3-trail")!;
    expect(t.status).toBe("candidate");
    expect(t.reasons).toContain("trailing");
  });

  it("overlapping bands keep all legal candidates as an interval", () => {
    const comp = run();
    const ov1 = comp.inferences.find((i) => i.bandId === "s3-ov1")!;
    const ov2 = comp.inferences.find((i) => i.bandId === "s3-ov2")!;
    expect(ov1.status).toBe("interval");
    expect(ov2.status).toBe("interval");
    expect(ov1.value.kind).toBe("candidates");
    expect((ov1.value as any).options.length).toBeGreaterThan(1);
    const ev = comp.events.find((e) => e.kind === "judgment:degraded-band-evidence" && (e.payload as any).bandId === "s3-ov1");
    expect((ev!.payload as any).overlapGroup).toContain("s3-ov2");
  });
});
