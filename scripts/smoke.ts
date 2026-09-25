import { Store } from "../src/server/store.js";
import { CasePackService } from "../src/server/casepack.js";
import { decodePng, detectGel } from "../src/server/image.js";
import { readFileSync } from "node:fs";
import { DEFAULT_PARAMS } from "../src/shared/params.js";

const png = readFileSync("case-pack/gel-case-pack.png");
const det = detectGel(decodePng(png), DEFAULT_PARAMS);
const li = det.lanes.findIndex(l => Math.abs(l.seedX-430)<20);
console.log("lane430 bands:", det.bands[li]?.map(b => ({y:b.center.y, pk:b.peakIntensity, ov:b.overlapGroupKey, tail:b.tailing, sat:b.saturated})));

const store = new Store(":memory:");
const svc = new CasePackService("case-pack");
const { projectId } = svc.materialize(store);
let st = store.getState(projectId);
console.log("BASELINE diagnostics:", [...new Set(st.computation!.diagnostics.map(d=>d.code))]);
for (const s of svc.info().scenarios) {
  const { result, state } = svc.applyScenario(store, projectId, s.id);
  st = state;
  console.log(s.id.padEnd(24), result.ok ? "OK" : "FAIL", result.status, JSON.stringify(result.evidenceMissing), result.message);
}
console.log("FINAL branches:", st.branches);
