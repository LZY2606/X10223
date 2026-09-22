import { Store } from '../src/server/store.js';
import { seedStore, loadCasePack, PROJECT_ID } from '../src/server/workspace.js';
import { computeAt } from '../src/server/replay-compute.js';
import { sha256Hex } from '../src/shared/digest.js';

export function freshStore(): Store {
  const store = new Store(':memory:');
  seedStore(store);
  return store;
}

export function branchView(store: Store, branchId: string, seq?: number) {
  return computeAt(store, branchId, seq);
}

export function bandStatuses(view: ReturnType<typeof branchView>) {
  const map: Record<string, string> = {};
  for (const r of view.bandResults) map[r.bandId] = r.status;
  return map;
}

export function codes(view: ReturnType<typeof branchView>) {
  return new Set(view.nodes.flatMap((n) => n.diagnostics.map((d) => d.code)));
}

export function scenarioBytes(name: string): Buffer {
  const { images } = loadCasePack();
  return images[`scenarios/${name}.png`];
}

export { seedStore, loadCasePack, PROJECT_ID, sha256Hex };
