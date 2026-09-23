/**
 * Builds the offline domain casepack "胶道标尺" (gel-ruler):
 * a synthetic gel image with smile curvature, a saturated band, an overlapping
 * pair and a trailing band, plus immutable materials with pixel-level provenance
 * (raw stored orientation is rotated 90 deg) and the counterexample archive.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { encodePngGray8 } from "./png.ts";

const W = 360, H = 480;              // normalized frame (wells up)
const RAW_W = H, RAW_H = W;          // stored raw image is rotated 90 deg
const Y0 = 30;
const LADDER_BP = [10000, 8000, 6000, 5000, 4000, 3000, 2000, 1000];
const LANES_X = [50, 120, 190, 260, 330];
const SAT = 250;

const dOf = (mw: number) => (4.1 - Math.log10(mw)) * 160;
const smile = (x: number) => 16 * Math.pow((x - 190) / 140, 2);

// deterministic PRNG (LCG)
let seed = 1234567;
const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

interface Band { id: string; lane: number; mw: number; intensity: number; trailing: number; extraDy?: number; }
const bands: Band[] = [];
LADDER_BP.forEach((mw, i) => bands.push({ id: `lad-${i}`, lane: 0, mw, intensity: 210, trailing: 0.1 }));
bands.push(
  { id: "s1-a", lane: 1, mw: 6000, intensity: 200, trailing: 0.1 },
  { id: "s1-b", lane: 1, mw: 3000, intensity: 195, trailing: 0.2 },
  { id: "s2-sat", lane: 2, mw: 4000, intensity: 255, trailing: 0.1 },   // saturated
  { id: "s2-far", lane: 2, mw: 800, intensity: 180, trailing: 0.1 },    // beyond ladder range
  { id: "s3-ov1", lane: 3, mw: 3200, intensity: 190, trailing: 0.1 },   // overlapping pair
  { id: "s3-ov2", lane: 3, mw: 3060, intensity: 190, trailing: 0.1 },
  { id: "s3-trail", lane: 3, mw: 2000, intensity: 185, trailing: 0.7 }, // trailing
  { id: "s4-a", lane: 4, mw: 8000, intensity: 200, trailing: 0.1 },
  { id: "s4-b", lane: 4, mw: 2000, intensity: 200, trailing: 0.1 },
);

const bandY = (b: Band) => Y0 + dOf(b.mw) + smile(LANES_X[b.lane]) + (b.extraDy ?? 0);

// --- render normalized frame ---
const img = new Float64Array(W * H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++)
    img[y * W + x] = 16 + 6 * (y / H) + rnd() * 3;
// lane strips
for (const lx of LANES_X)
  for (let x = lx - 16; x <= lx + 16; x++)
    for (let y = 8; y < H - 8; y++)
      if (x >= 0 && x < W) img[y * W + x] += 8;
// bands as gaussian blobs
for (const b of bands) {
  const cx = LANES_X[b.lane], cy = bandY(b);
  const sy = b.trailing > 0.5 ? 5 : 3; // trailing bands smear downward
  for (let dy = -14; dy <= 14 + (b.trailing > 0.5 ? 14 : 0); dy++)
    for (let dx = -12; dx <= 12; dx++) {
      const x = Math.round(cx + dx), y = Math.round(cy + dy);
      if (x < 0 || x >= W || y < 0 || y >= H) continue;
      const g = Math.exp(-(dx * dx) / 18 - (dy * dy) / (2 * sy * sy));
      img[y * W + x] += b.intensity * g * (dy > 0 && b.trailing > 0.5 ? b.trailing * 0.6 : 1);
    }
}
// rotate into raw stored orientation (90 deg): raw.x = RAW_W-1-y, raw.y = x
const raw = new Uint8Array(RAW_W * RAW_H);
for (let y = 0; y < H; y++)
  for (let x = 0; x < W; x++) {
    const rx = RAW_W - 1 - y, ry = x;
    raw[ry * RAW_W + rx] = Math.max(0, Math.min(255, Math.round(img[y * W + x])));
  }

const toRaw = (x: number, y: number) => ({ x: Math.round(RAW_W - 1 - y), y: Math.round(x) });

// lane boundary polylines (raw pixel provenance), smile-encoded per lane
const lanes = LANES_X.map((lx, i) => {
  const s = smile(lx);
  const a = s / 300, bq = (0.00002 * s);
  const pts = [];
  for (let y = 20; y <= 460; y += 40) {
    const xn = lx + a * y + bq * y * y * 0; // centerline drift encodes smile via c1
    pts.push(toRaw(xn, y));
  }
  return { id: `lane-${i}`, boundaryRaw: pts };
});

const bandMats = bands.map((b) => {
  const p = toRaw(LANES_X[b.lane], bandY(b));
  return {
    id: b.id, laneId: `lane-${b.lane}`, x: p.x, y: p.y,
    maxIntensity: b.intensity, trailingScore: b.trailing,
  };
});

const materials = {
  name: "gel-ruler-casepack",
  image: { file: "gel.png", width: RAW_W, height: RAW_H },
  capture: { orientationDeg: 90, exposureRaw: "2.5 kV*h" },
  ladder: { laneIndex: 0, sizesRaw: LADDER_BP.map((v) => `${v} bp`) },
  lanes,
  bands: bandMats,
  saturationThreshold: SAT,
};

const scenarios = {
  archive: "gel-ruler counterexample archive",
  baseline: "原图/拍摄方向/曝光/ladder 标称值/lane 边界/条带中心均保留像素级来源",
  mutations: [
    { id: "rotated-image", title: "旋转图像", change: "capture.orientationDeg", note: "raw 存储旋转 90°,派生层规范化,原始像素来源保留" },
    { id: "curved-lanes", title: "弯曲泳道(微笑)", change: "lane-boundary", note: "同一高度不等于同一分子量,局部标尺必须带有效区域" },
    { id: "ladder-missing-band", title: "ladder 缺带", change: "ladder-nominal", note: "标称 8 条可见 7 条,产生带位置诊断" },
    { id: "saturated-region", title: "饱和区", change: "band-center s2-sat", note: "只能标为候选" },
    { id: "overlapping-bands", title: "两条带重叠", change: "band-center s3-ov1/s3-ov2", note: "只能标为区间,保留全部合法候选" },
    { id: "non-monotonic-ruler", title: "非单调标尺", change: "ladder-nominal swap", note: "semantic_unsolvable,区别于格式损坏与预算耗尽" },
    { id: "local-invalidation", title: "修订后局部失效", change: "lane-boundary lane-3", note: "仅 lane-3 的派生结果失效,其余保持身份" },
  ],
};

mkdirSync("casepack/gel-ruler", { recursive: true });
writeFileSync("casepack/gel-ruler/gel.png", encodePngGray8(RAW_W, RAW_H, raw));
writeFileSync("casepack/gel-ruler/materials.json", JSON.stringify(materials, null, 2));
writeFileSync("casepack/gel-ruler/scenarios.json", JSON.stringify(scenarios, null, 2));
console.log("casepack written:", bands.length, "bands,", lanes.length, "lanes");
