import { Store } from "../src/server/store.js";
import { CasePackService } from "../src/server/casepack.js";
import { rotatePointCw } from "../src/shared/geometry.js";

const store = new Store(":memory:");
const svc = new CasePackService("case-pack");
const { manifest } = svc.loadPack();
const { projectId } = svc.materialize(store);
for (const id of ["baseline","curved-smile","saturation-overlap-tail","param-revision","rotate","missing-band","nonmonotonic"]) {
  svc.applyScenario(store, projectId, id);
}
const st = store.getState(projectId);
console.log("frame:", st.activeFrame);
const lane3 = Object.values(st.materials).find((m:any) => m.kind==="lane" && m.laneOrdinal===3 && m.frame==="rotated");
console.log("lane3:", lane3?.id, "ladderSpecId:", (lane3 as any)?.ladderSpecId);
console.log("calibration decisions on lane3:", st.events.filter((e:any)=>e.kind==="decision"&&e.targetId===lane3?.id).map((e:any)=>({verb:e.verb, value:e.valueRaw})));
const fit = st.computation!.fits.find(f=>f.ladderLaneId===lane3?.id);
console.log("fit3 segments:", fit?.segments.map(s=>({lo:s.lowOrdinal,hi:s.highOrdinal,mono:s.monotonic})));
const specs = Object.values(st.materials).filter((m:any)=>m.kind==="ladder-spec").map((m:any)=>({id:m.id.slice(0,20), o4:m.bands.find((b:any)=>b.ordinal===4)?.nominal.raw}));
console.log("specs:", specs);
console.log("NONMONO diagnostics:", st.computation!.diagnostics.filter(d=>d.code==="GEL-RULER-NONMONO-007").length);
const gt = manifest.groundTruth.bands.find(b=>b.kind==="overlap-a")!;
const p = rotatePointCw(gt.center, 90, manifest.image.width, manifest.image.height);
console.log("rotated overlap-a target:", p);
const bands = Object.values(st.materials).filter((m:any)=>m.kind==="band"&&m.frame==="rotated");
const lane4 = Object.values(st.materials).find((m:any)=>m.kind==="lane"&&m.laneOrdinal===4&&m.frame==="rotated") as any;
console.log("lane4:", lane4?.id);
console.log("lane4 bands near:", bands.filter((b:any)=>b.laneId===lane4?.id).map((b:any)=>({y:b.center.y,x:b.center.x, d:Math.hypot(b.center.x-p.x,b.center.y-p.y)})));
