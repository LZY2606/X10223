import { Store } from "../src/server/store.js";
import { CasePackService } from "../src/server/casepack.js";
const store = new Store(":memory:");
const svc = new CasePackService("case-pack");
const { projectId } = svc.materialize(store);
for (const id of ["baseline","curved-smile","saturation-overlap-tail","param-revision","rotate","missing-band","nonmonotonic"]) svc.applyScenario(store, projectId, id);
const st = store.getState(projectId);
for (const ord of [0,3]) {
  const lane = Object.values(st.materials).find((m:any)=>m.kind==="lane"&&m.laneOrdinal===ord&&m.frame==="rotated") as any;
  const bands = Object.values(st.materials).filter((m:any)=>m.kind==="band"&&m.laneId===lane.id) as any[];
  console.log(`lane${ord} n=${bands.length}`, bands.map(b=>`(${b.center.x.toFixed(0)},${b.center.y.toFixed(0)})${b.saturated?"S":""}`).join(" "));
  const fit = st.computation!.fits.find(f=>f.ladderLaneId===lane.id);
  console.log("  residual ordinals(arc order):", fit?.residuals.map((r:any)=>r.ladderBandId.slice(-4)));
}
