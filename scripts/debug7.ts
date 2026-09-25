import { Store } from "../src/server/store.js";
import { CasePackService } from "../src/server/casepack.js";
import { arcLocus, arcOfPoint } from "../src/shared/geometry.js";
const store = new Store(":memory:");
const svc = new CasePackService("case-pack");
const { projectId } = svc.materialize(store);
const ids = ["baseline","curved-smile","saturation-overlap-tail","param-revision","rotate","missing-band","nonmonotonic"];
for (const id of ids) { const r = svc.applyScenario(store, projectId, id); if(id==="nonmonotonic") console.log("nonmono result:", r.result); }
const st = store.getState(projectId);
for (const ord of [0,3]) {
  const lane = Object.values(st.materials).find((m:any)=>m.kind==="lane"&&m.laneOrdinal===ord&&m.frame==="rotated") as any;
  const fit = st.computation!.fits.find(f=>f.ladderLaneId===lane.id);
  console.log(`fit lane${ord} segs:`, fit?.segments.map((s:any)=>`${s.lowOrdinal}-${s.highOrdinal}:${s.monotonic?"m":"NM"}`).join(" "));
  console.log(`  residuals:`, fit?.residuals.map((r:any)=>Math.round(r.s)));
}
