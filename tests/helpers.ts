import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { GelStore } from '../src/server/store';
import { ProjectService } from '../src/server/projectService';
import { buildBaseline, buildVariant } from '../src/casepack/builder';
import { analyze } from '../src/core/analyze';
import { stableId } from '../src/shared/ids';
import type { GelInput } from '../src/core/types';

export function tempService(): { service: ProjectService; dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), 'gel-test-'));
  const store = new GelStore(join(dir, 'test.db'));
  const service = new ProjectService(store);
  return { service, dir, cleanup: () => { store.close(); rmSync(dir, { recursive: true, force: true }); } };
}

export function analyzeVariant(variantId: string) {
  const c = variantId === 'baseline' ? buildBaseline() : buildVariant(variantId);
  const input: GelInput = { image: c.image, ladder: c.ladder, lanes: c.lanes, bands: c.bands };
  const result = analyze(input, stableId('evt-test', variantId), { lanes: c.lanes, bands: c.bands });
  return { c, input, result };
}

export function analyzeBaseline() {
  return analyzeVariant('baseline');
}
