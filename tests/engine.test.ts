import { describe, expect, it } from 'vitest';
import { runPipeline } from '../src/domain/engine.ts';
import { PARAMS_V1 } from '../src/domain/types.ts';
import { normalizeQuantity } from '../src/domain/units.ts';
import { CASEPACK, rerun, seededStore } from './helpers.ts';
import { loadCasePack } from '../src/domain/casepack.ts';
import { Store } from '../src/server/store.ts';

describe('engine basics', () => {
  it('equivalent inputs yield identical ids and stable ordering', () => {
    const store = seededStore();
    const a = rerun(store);
    const b = rerun(store);
    expect(a.outcome.kind).toBe('ok');
    expect(a.results.map((r) => r.id)).toEqual(b.results.map((r) => r.id));
    const sorted = [...a.results].sort((x, y) => x.kind.localeCompare(y.kind) || x.id.localeCompare(y.id));
    expect(a.results.map((r) => r.id)).toEqual(sorted.map((r) => r.id));
  });

  it('incomplete input returns positioned diagnostics, never fake success', () => {
    const store = seededStore();
    const materials = store.listMaterials().filter((m) => m.kind !== 'exposure');
    const result = runPipeline(materials, PARAMS_V1);
    expect(result.outcome.kind).toBe('semantically_unsolvable');
    if (result.outcome.kind !== 'semantically_unsolvable') throw new Error('unreachable');
    expect(result.outcome.diagnostics.some((d) => d.path === 'materials.exposure' && d.code === 'INPUT_MISSING')).toBe(true);
    expect(result.results).toHaveLength(0);
  });

  it('budget exhaustion is a distinct outcome', () => {
    const store = seededStore();
    const result = runPipeline(store.listMaterials(), { ...PARAMS_V1, solver_budget: 1 });
    expect(result.outcome.kind).toBe('budget_exhausted');
  });

  it('unconvertible units stay in place with diagnostics', () => {
    const bad = normalizeQuantity({ value: 250, unit: 'furlongs' }, 'exposure.time');
    expect(bad.value).toBeUndefined();
    expect(bad.diagnostics[0].path).toBe('exposure.time.unit');
    expect(bad.diagnostics[0].code).toBe('UNIT_UNKNOWN');
    const bare = normalizeQuantity(42, 'exposure.time');
    expect(bare.value).toBeUndefined();
    expect(bare.diagnostics[0].code).toBe('UNIT_MISSING');
    const ok = normalizeQuantity({ value: 250, unit: 'ms' }, 'exposure.time');
    expect(ok.value).toEqual({ value: 250, unit: 'ms' });
  });

  it('case pack seeds the full narrative: revision, local amendment, conflict', () => {
    const store = new Store(':memory:');
    const report = loadCasePack(CASEPACK);
    expect(report.title).toContain('胶道标尺');
    const seeded = seededStore();
    const events = seeded.listEvents();
    expect(events.some((e) => e.type === 'params.revised')).toBe(true);
    expect(events.some((e) => e.type === 'source.amended')).toBe(true);
    expect(events.some((e) => e.type === 'conflict.recorded')).toBe(true);
    expect(events.some((e) => e.type === 'judgement.recorded')).toBe(true);
    expect(seeded.branches()).toContain('reviewer-2');
  });
});
