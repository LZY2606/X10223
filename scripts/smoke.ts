import { buildCasepack } from '../src/core/casepack';
import { replay } from '../src/core/state';
const { bundle, branchNames } = buildCasepack();
const created = bundle.events[0];
const project = created.payload.project as any;
console.log('events', bundle.events.length, 'blobs', bundle.blobs.length);
for (const name of branchNames) {
  const evs = bundle.events.filter(e => e.branch === name || e.type === 'project-created');
  const state = replay(evs, project);
  const cals = Object.values(state.calibrationResults);
  const masses = Object.values(state.massResults);
  const statuses: Record<string, number> = {};
  for (const m of masses) statuses[m.status] = (statuses[m.status] ?? 0) + 1;
  const cal = cals[cals.length - 1];
  const diagCodes = new Set<string>();
  for (const e of evs) for (const d of e.diagnostics ?? []) diagCodes.add(d.code);
  console.log(name.padEnd(20),
    'cals=', cals.length,
    'mono=', cal?.monotonic,
    'rms=', cal?.rmsResidualFrac,
    'masses=', masses.length,
    JSON.stringify(statuses),
    [...diagCodes].join(','));
}
