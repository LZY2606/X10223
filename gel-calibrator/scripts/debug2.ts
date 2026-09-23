import { openDB } from '../src/server/db.js';
import { Store } from '../src/server/store.js';
import { seedStore } from '../src/server/seed.js';
const db = openDB(':memory:'); const store = new Store(db);
const seed = seedStore(store); const nid = seed.narrativeId;
for (const b of store.listBranches(nid).map(x=>x.branch)) {
  const st = store.stateAt(nid, b);
  console.log('\n==', b, 'params', st.params.version, 'materials', st.materials.length);
  console.log(' decisions:', st.decisions.map(d=>`${d.targetValueId.slice(0,18)}:${d.action}(${d.actor})`).join(' | ')||'-');
  console.log(' inferences:', st.inferences.map(i=>`${i.bandKey}=${i.verdict.type}`).join(', '));
  console.log(' diag:', st.diagnostics.map(d=>d.code).join(',')||'-');
}
