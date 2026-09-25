import { decodePng, detectGel } from "../src/server/image.js";
import { readFileSync } from "node:fs";
import { DEFAULT_PARAMS } from "../src/shared/params.js";
const det = detectGel(decodePng(readFileSync("case-pack/gel-case-pack.png")), DEFAULT_PARAMS);
const lane = det.lanes.find(l => Math.abs(l.seedX - 430) < 20)!;
for (const p of lane.profile) {
  if (p.y > 90 && p.y < 135) console.log(p.y, Math.round(p.intensity), p.x.toFixed(1));
}
const lane5 = det.lanes.find(l => Math.abs(l.seedX - 520) < 20)!;
console.log("lane5 bands:", det.bands[det.lanes.indexOf(lane5)]?.map(b => Math.round(b.center.y)));
