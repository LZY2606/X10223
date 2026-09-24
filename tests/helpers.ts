import { Store } from '../src/server/store.ts';
import { loadCasePack, runCasePack } from '../src/domain/casepack.ts';
import { runPipeline } from '../src/domain/engine.ts';
import { PARAMS_V1, type Material, type ParamSet } from '../src/domain/types.ts';
import { join } from 'node:path';

export const CASEPACK = join(process.cwd(), 'casepack', 'case.json');

export function seededStore(): Store {
  const store = new Store(':memory:');
  runCasePack(store, loadCasePack(CASEPACK));
  return store;
}

export function rerun(store: Store, params: ParamSet = { ...PARAMS_V1, version: 'params-v2', overlap_min_sep_px: 12 }) {
  const materials = store.listMaterials();
  const imageMat = materials.filter((m) => m.kind === 'gel_image').sort((a, b) => b.seq - a.seq)[0];
  const image = store.imageAccess(imageMat.id);
  return runPipeline(materials, params, image);
}

export function currentByKind(store: Store, kind: string, label: string): Material {
  const matches = store.listMaterials()
    .filter((m) => m.kind === kind && m.label === label)
    .sort((a, b) => b.seq - a.seq);
  return matches[0];
}
