import { describe, it, expect } from "vitest";
import { rotatePoint, unrotatePoint } from "../src/domain/geometry.ts";
import { ingestCasepack, computeDerived, Budget } from "../src/domain/pipeline.ts";
import { makePack, W, H } from "./fixture.ts";

describe("旋转图像 (rotated capture)", () => {
  it("rotate/unrotate round-trips pixel coordinates", () => {
    for (const deg of [0, 90, 180, 270] as const) {
      const p = { x: 123, y: 45 };
      const q = rotatePoint(p, deg, 480, 360);
      const back = unrotatePoint(q, deg, 480, 360);
      expect(back).toEqual(p);
    }
  });

  it("keeps pixel-level provenance: materials raw, derived normalized", () => {
    const pack = makePack();
    const ing = ingestCasepack(pack, { maxOps: 10000 } as Budget, 0);
    expect(ing.ok).toBe(true);
    if (!ing.ok) return;
    const bandMat = ing.value.materials.find((m) => m.kind === "band-center")!;
    const payload = bandMat.payload as any;
    expect(payload.basis).toBe("image-raw"); // 像素级来源保留在原始坐标系
    const comp = computeDerived(ing.value, { maxOps: 10000 } as Budget, 1);
    expect(comp.ok).toBe(true);
    if (!comp.ok) return;
    const curve = comp.value.derived.find((d) => d.kind === "lane-curve")!;
    expect((curve.payload as any).basis).toBe("image-norm");
    // normalized frame dimensions: raw 480x360 rotated 90 -> 360x480
    expect(H).toBe(480);
    expect(W).toBe(360);
  });
});
