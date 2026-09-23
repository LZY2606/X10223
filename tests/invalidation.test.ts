import { describe, it, expect } from "vitest";
import { GelApp } from "../server/app.ts";

describe("修订后局部失效 (local invalidation)", () => {
  it("changing one lane boundary supersedes only that lane's derived results", () => {
    const app = new GelApp(":memory:", "casepack/gel-ruler");
    const seeded = app.seed();
    expect(seeded.ok).toBe(true);
    const before = app.state();
    const laneMat = before.materials.find((m) => m.kind === "lane-boundary" && (m.payload as any).laneId === "lane-3")!;
    const lane3InfBefore = before.derived.filter((d) => d.kind === "inference" && (d.payload as any).laneId === "lane-3");
    const lane1InfBefore = before.derived.filter((d) => d.kind === "inference" && (d.payload as any).laneId === "lane-1");
    expect(lane3InfBefore.length).toBeGreaterThan(0);
    expect(lane1InfBefore.length).toBeGreaterThan(0);

    const newPayload = { ...(laneMat.payload as any), points: (laneMat.payload as any).points.map((p: any) => ({ x: p.x + 2, y: p.y })) };
    const r = app.sourceChange(laneMat.id, newPayload);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const after = app.state();
    // old material stays (immutable), new version points back
    expect(after.materials.find((m) => m.id === laneMat.id)).toBeDefined();
    const fresh = after.materials.find((m) => m.id === r.value.newMaterialId)!;
    expect(fresh.supersedes).toBe(laneMat.id);
    expect(fresh.version).toBe(2);
    // lane-3 derived superseded, lane-1 untouched with identical ids
    for (const d of lane3InfBefore) {
      expect(after.derived.find((x) => x.id === d.id)!.status).toBe("superseded");
    }
    for (const d of lane1InfBefore) {
      expect(after.derived.find((x) => x.id === d.id)!.status).toBe("current");
    }
    // the superseded set is exactly the lane-3 dependency cone
    expect(r.value.superseded.sort()).toEqual(
      before.derived.filter((d) => (d.kind === "inference" && (d.payload as any).laneId === "lane-3") || (d.kind === "lane-curve" && (d.payload as any).laneId === "lane-3")).map((d) => d.id).sort()
    );
    app.close();
  });
});
