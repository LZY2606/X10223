import { openDB } from '../src/server/db.js';
import { Store } from '../src/server/store.js';
import { seedStore } from '../src/server/seed.js';
const db = openDB(':memory:'); const store = new Store(db);
const seed = seedStore(store); const nid = seed.narrativeId;
for (const e of store.allEvents(nid).filter(e=>e.branch==='conflict'||e.branch==='main')) {
  console.log(e.branch, e.seq, e.type);
}
console.log('branches', store.listBranches(nid));
