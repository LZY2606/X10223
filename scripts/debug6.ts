import { Store } from "../src/server/store.js";
import { CasePackService } from "../src/server/casepack.js";
const store = new Store(":memory:");
const svc = new CasePackService("case-pack");
const { projectId } = svc.materialize(store);
for (const id of ["baseline","curved-smile","saturation-overlap-tail","param-revision","rotate","missing-band"]) {
  svc.applyScenario(store, projectId, id);
}
const st = store.getState(projectId);
const allBands = Object.values(st.materials).filter((m:any)=>m.kind==="band");
console.log("rotated bands total:", allBands.filter((b:any)=>b.frame==="rotated").length);
const lanes4 = Object.values(st.materials).filter((m:any)=>m.kind==="lane"&&m.laneOrdinal===4);
for (const l of lanes4 as any[]) console.log("lane4", l.frame, l.id);
const lane4r = lanes4.find((l:any)=>l.frame==="rotated") as any;
console.log("bands by lane (rotated):", allBands.filter((b:any)=>b.frame==="rotated").reduce((acc:any,b:any)=>{acc[b.laneId]=(acc[b.laneId]??0)+1;return acc;},{}));
const retractions = st.events.filter((e:any)=>e.kind==="retraction");
for (const r of retractions as any[]) console.log("retraction", r.reason.slice(0,60), "count:", r.retractedMaterialIds.length);
