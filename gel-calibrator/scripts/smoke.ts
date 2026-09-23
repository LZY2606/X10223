import { openDB } from '../src/server/db.js';
import { Store } from '../src/server/store.js';
import { seedStore } from '../src/server/seed.js';

const db = openDB(':memory:');
const store = new Store(db);
const seed = seedStore(store);
for (const p of store.listProjects()) {
  const st = store.stateAt(p.project_id, 'main');
  const inf = st.inferences;
  const verdicts = inf.map((i) => i.verdict.type);
  const calib = Object.entries(st.calibration).map(([lane, c]) => `${lane}:${c.state}`);
  console.log(
    p.case_kind.padEnd(14), '| events', store.allEvents(p.project_id).length,
    '| bands', inf.length, '|', verdicts.join(',') || '-', '|', calib.join(' '),
    '| diag', st.diagnostics.length,
  );
}
const nid = seed.narrativeId;
console.log('\nnarrative branches:', store.listBranches(nid).map((b) => b.branch).join(', '));
for (const b of store.listBranches(nid)) {
  const st = store.stateAt(nid, b.branch);
  console.log(' branch', b.branch.padEnd(14), 'events', store.allEvents(nid).filter(e=>e.branch===b.branch).length,
    'inferences', st.inferences.length, 'decisions', st.decisions.length, 'params', st.params.version);
}
