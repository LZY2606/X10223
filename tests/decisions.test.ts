import { describe, it, expect } from "vitest";
import { GelApp } from "../server/app.ts";

describe("人工决定冲突与历史回放", () => {
  it("conflicting decisions coexist on branches; replay restores historical view", () => {
    const app = new GelApp(":memory:", "casepack/gel-ruler");
    app.seed();
    const s0 = app.state();
    const lane3Inf = s0.derived.find((d) => d.kind === "inference" && (d.payload as any).laneId === "lane-3")!;

    const accept = app.decide("decision:accept", ["s3-ov1"], "reviewer A: accept 3200bp candidate", "main");
    const reject = app.decide("decision:reject", ["s3-ov1"], "reviewer B: overlap not resolvable", "review-b");
    const all = app.state();
    // both decisions retained
    expect(all.events.find((e) => e.id === accept.id)).toBeDefined();
    expect(all.events.find((e) => e.id === reject.id)).toBeDefined();
    expect(all.branches.map((b) => b.id)).toContain("review-b");

    // now a source change supersedes lane-3 derived results
    const laneMat = all.materials.find((m) => m.kind === "lane-boundary" && (m.payload as any).laneId === "lane-3")!;
    const r = app.sourceChange(laneMat.id, { ...(laneMat.payload as any), points: (laneMat.payload as any).points.map((p: any) => ({ x: p.x + 1, y: p.y })) });
    expect(r.ok).toBe(true);
    expect(app.state().derived.find((d) => d.id === lane3Inf.id)!.status).toBe("superseded");

    // replay to before the source change: historical dependency versions restored
    const replay = app.replay(accept.seq);
    expect(replay.derived.find((d) => d.id === lane3Inf.id)).toBeDefined();
    // replay does not rewrite history: current state still marks it superseded
    expect(app.state().derived.find((d) => d.id === lane3Inf.id)!.status).toBe("superseded");
    app.close();
  });
});
